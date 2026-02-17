import Types "Types";
import Array "mo:base/Array";
import Nat "mo:base/Nat";
import Text "mo:base/Text";
import Time "mo:base/Time";
import Trie "mo:base/Trie";
import Result "mo:base/Result";
import Principal "mo:base/Principal";
import ExperimentalCycles "mo:base/ExperimentalCycles";

/// Per-user persistent vault canister.
/// Uses Trie (functional, stable) for maps and arrays for the audit log.
/// All vars persist across upgrades via Enhanced Orthogonal Persistence.
persistent actor class UserVault(initOwner : Principal) {

  // -- State --
  // All vars implicitly stable (EOP). Using Trie for stable key-value maps.

  let owner : Principal = initOwner;

  var memories : Trie.Trie<Text, Types.MemoryEntry> = Trie.empty();
  var sessions : Trie.Trie<Text, Types.SessionEntry> = Trie.empty();

  // Immutable audit log -- append-only array, never deleted/modified
  var auditLog : [Types.AuditEntry] = [];

  var lastUpdated : Int = 0;

  // Track sizes separately for O(1) lookups (Trie doesn't have a .size() method)
  var memoriesCount : Nat = 0;
  var sessionsCount : Nat = 0;

  // -- Trie key helpers --

  func textKey(t : Text) : Trie.Key<Text> {
    { key = t; hash = Text.hash(t) };
  };

  // -- Internal helpers --

  /// Append an entry to the immutable audit log.
  func appendAudit(entry : Types.AuditEntry) {
    auditLog := Array.append(auditLog, [entry]);
  };

  /// Verify caller is vault owner. Logs access denial if not.
  func assertOwner(caller : Principal) : Bool {
    if (caller == owner) { return true };
    appendAudit({
      timestamp = Time.now();
      action = #accessDenied;
      caller = caller;
      key = null;
      category = null;
      details = ?"Unauthorized access attempt";
    });
    false;
  };

  /// Compute estimated bytes used by the vault.
  func computeBytesUsed() : Nat {
    var total : Nat = 0;
    for ((_, entry) in Trie.iter(memories)) {
      total += entry.key.size() + entry.category.size() + entry.content.size() + entry.metadata.size() + 32;
    };
    for ((_, session) in Trie.iter(sessions)) {
      total += session.sessionId.size() + session.data.size() + 32;
    };
    total += auditLog.size() * 128; // rough estimate per audit entry
    total;
  };

  /// Get unique categories from memories.
  func getUniqueCategories() : [Text] {
    var catTrie : Trie.Trie<Text, Bool> = Trie.empty();
    for ((_, entry) in Trie.iter(memories)) {
      catTrie := Trie.put(catTrie, textKey(entry.category), Text.equal, true).0;
    };
    Trie.toArray<Text, Bool, Text>(catTrie, func(k, _) { k });
  };

  /// Build VaultStats
  func buildStats() : Types.VaultStats {
    {
      totalMemories = memoriesCount;
      totalSessions = sessionsCount;
      categories = getUniqueCategories();
      bytesUsed = computeBytesUsed();
      cycleBalance = ExperimentalCycles.balance();
      lastUpdated = lastUpdated;
    };
  };

  /// Get recent memories sorted by updatedAt (most recent first), limited.
  func getRecentMemories(limit : Nat) : [Types.MemoryEntry] {
    let all = Trie.toArray<Text, Types.MemoryEntry, Types.MemoryEntry>(
      memories,
      func(_, v) { v },
    );
    let sorted = Array.sort<Types.MemoryEntry>(all, func(a, b) {
      if (a.updatedAt > b.updatedAt) { #less }
      else if (a.updatedAt < b.updatedAt) { #greater }
      else { #equal };
    });
    let resultSize = if (sorted.size() < limit) { sorted.size() } else { limit };
    Array.tabulate<Types.MemoryEntry>(resultSize, func(i) { sorted[i] });
  };

  /// Get recent sessions sorted by startedAt (most recent first), limited.
  func getRecentSessions(limit : Nat) : [Types.SessionEntry] {
    let all = Trie.toArray<Text, Types.SessionEntry, Types.SessionEntry>(
      sessions,
      func(_, v) { v },
    );
    let sorted = Array.sort<Types.SessionEntry>(all, func(a, b) {
      if (a.startedAt > b.startedAt) { #less }
      else if (a.startedAt < b.startedAt) { #greater }
      else { #equal };
    });
    let resultSize = if (sorted.size() < limit) { sorted.size() } else { limit };
    Array.tabulate<Types.SessionEntry>(resultSize, func(i) { sorted[i] });
  };

  /// Simple checksum for a category's entries.
  func categoryChecksum(category : Text) : Text {
    var entries : [Text] = [];
    for ((_, entry) in Trie.iter(memories)) {
      if (entry.category == category) {
        entries := Array.append(entries, [entry.key # ":" # debug_show(entry.updatedAt)]);
      };
    };
    let sorted = Array.sort<Text>(entries, Text.compare);
    Text.join("|", sorted.vals());
  };

  // -- UPDATE CALLS (cost cycles, require consensus) --

  /// Store or update a single memory entry.
  public shared ({ caller }) func store(
    key : Text,
    category : Text,
    content : Blob,
    metadata : Text,
  ) : async Result.Result<(), Types.VaultError> {
    if (not assertOwner(caller)) {
      return #err(#unauthorized);
    };
    if (key == "" or category == "") {
      return #err(#invalidInput("key and category must not be empty"));
    };

    let now = Time.now();
    let existing = Trie.get(memories, textKey(key), Text.equal);
    let createdAt = switch (existing) {
      case (?e) { e.createdAt };
      case null { now };
    };

    let (newMemories, old) = Trie.put(memories, textKey(key), Text.equal, {
      key = key;
      category = category;
      content = content;
      metadata = metadata;
      createdAt = createdAt;
      updatedAt = now;
    });
    memories := newMemories;

    // Update count if this is a new entry
    switch (old) {
      case null { memoriesCount += 1 };
      case _ {};
    };

    lastUpdated := now;

    appendAudit({
      timestamp = now;
      action = #store;
      caller = caller;
      key = ?key;
      category = ?category;
      details = null;
    });

    #ok(());
  };

  /// Delete a memory by key.
  public shared ({ caller }) func delete(key : Text) : async Result.Result<(), Types.VaultError> {
    if (not assertOwner(caller)) {
      return #err(#unauthorized);
    };

    let existing = Trie.get(memories, textKey(key), Text.equal);
    switch (existing) {
      case (?removed) {
        let (newMemories, _) = Trie.remove(memories, textKey(key), Text.equal);
        memories := newMemories;
        memoriesCount -= 1;

        let now = Time.now();
        lastUpdated := now;
        appendAudit({
          timestamp = now;
          action = #delete;
          caller = caller;
          key = ?key;
          category = ?removed.category;
          details = null;
        });
        #ok(());
      };
      case null { #err(#notFound) };
    };
  };

  /// Bulk sync memories and sessions from local storage.
  /// Skips entries where the vault's version is newer (based on updatedAt).
  public shared ({ caller }) func bulkSync(
    memoryInputs : [Types.MemoryInput],
    sessionInputs : [Types.SessionInput],
  ) : async Result.Result<Types.SyncResult, Types.VaultError> {
    if (not assertOwner(caller)) {
      return #err(#unauthorized);
    };

    var stored : Nat = 0;
    var skipped : Nat = 0;
    var errors : [Text] = [];

    // Sync memories
    for (input in memoryInputs.vals()) {
      if (input.key == "" or input.category == "") {
        errors := Array.append(errors, ["Skipped memory with empty key or category"]);
        skipped += 1;
      } else {
        let shouldStore = switch (Trie.get(memories, textKey(input.key), Text.equal)) {
          case (?existing) { input.updatedAt > existing.updatedAt };
          case null { true };
        };
        if (shouldStore) {
          let isNew = switch (Trie.get(memories, textKey(input.key), Text.equal)) {
            case null { true };
            case _ { false };
          };
          let (newMem, _) = Trie.put(memories, textKey(input.key), Text.equal, {
            key = input.key;
            category = input.category;
            content = input.content;
            metadata = input.metadata;
            createdAt = input.createdAt;
            updatedAt = input.updatedAt;
          });
          memories := newMem;
          if (isNew) { memoriesCount += 1 };
          stored += 1;
        } else {
          skipped += 1;
        };
      };
    };

    // Sync sessions
    for (input in sessionInputs.vals()) {
      if (input.sessionId == "") {
        errors := Array.append(errors, ["Skipped session with empty sessionId"]);
        skipped += 1;
      } else {
        let shouldStore = switch (Trie.get(sessions, textKey(input.sessionId), Text.equal)) {
          case (?existing) { input.startedAt > existing.startedAt };
          case null { true };
        };
        if (shouldStore) {
          let isNew = switch (Trie.get(sessions, textKey(input.sessionId), Text.equal)) {
            case null { true };
            case _ { false };
          };
          let (newSess, _) = Trie.put(sessions, textKey(input.sessionId), Text.equal, {
            sessionId = input.sessionId;
            data = input.data;
            startedAt = input.startedAt;
            endedAt = input.endedAt;
          });
          sessions := newSess;
          if (isNew) { sessionsCount += 1 };
          stored += 1;
        } else {
          skipped += 1;
        };
      };
    };

    let now = Time.now();
    lastUpdated := now;

    appendAudit({
      timestamp = now;
      action = #bulkSync;
      caller = caller;
      key = null;
      category = null;
      details = ?("synced " # Nat.toText(stored) # " entries, skipped " # Nat.toText(skipped));
    });

    #ok({
      stored = stored;
      skipped = skipped;
      errors = errors;
    });
  };

  /// Store a session.
  public shared ({ caller }) func storeSession(
    sessionId : Text,
    data : Blob,
    startedAt : Int,
    endedAt : Int,
  ) : async Result.Result<(), Types.VaultError> {
    if (not assertOwner(caller)) {
      return #err(#unauthorized);
    };
    if (sessionId == "") {
      return #err(#invalidInput("sessionId must not be empty"));
    };

    let isNew = switch (Trie.get(sessions, textKey(sessionId), Text.equal)) {
      case null { true };
      case _ { false };
    };

    let (newSess, _) = Trie.put(sessions, textKey(sessionId), Text.equal, {
      sessionId = sessionId;
      data = data;
      startedAt = startedAt;
      endedAt = endedAt;
    });
    sessions := newSess;
    if (isNew) { sessionsCount += 1 };

    let now = Time.now();
    lastUpdated := now;

    appendAudit({
      timestamp = now;
      action = #store;
      caller = caller;
      key = ?sessionId;
      category = ?"session";
      details = null;
    });

    #ok(());
  };

  // -- QUERY CALLS (free, no consensus needed) --

  /// Recall a specific memory by key.
  public query ({ caller }) func recall(key : Text) : async ?Types.MemoryEntry {
    assert (caller == owner);
    Trie.get(memories, textKey(key), Text.equal);
  };

  /// Get vault statistics.
  public query ({ caller }) func getStats() : async Types.VaultStats {
    assert (caller == owner);
    buildStats();
  };

  /// Get unique categories.
  public query ({ caller }) func getCategories() : async [Text] {
    assert (caller == owner);
    getUniqueCategories();
  };

  /// Get paginated audit log entries (chronological order).
  public query ({ caller }) func getAuditLog(offset : Nat, limit : Nat) : async [Types.AuditEntry] {
    assert (caller == owner);
    let size = auditLog.size();
    if (offset >= size) { return [] };
    let end = if (offset + limit > size) { size } else { offset + limit };
    Array.tabulate<Types.AuditEntry>(end - offset, func(i) { auditLog[offset + i] });
  };

  /// Get total audit log size.
  public query ({ caller }) func getAuditLogSize() : async Nat {
    assert (caller == owner);
    auditLog.size();
  };

  /// Get vault owner principal.
  public query func getOwner() : async Principal {
    owner;
  };

  // -- COMPOSITE QUERIES (free, single round trip) --

  /// Dashboard: stats + recent memories + recent sessions in one call.
  public composite query ({ caller }) func getDashboard() : async Types.DashboardData {
    assert (caller == owner);
    {
      stats = buildStats();
      recentMemories = getRecentMemories(10);
      recentSessions = getRecentSessions(5);
    };
  };

  /// Search memories by category and/or key prefix, with limit.
  public composite query ({ caller }) func recallRelevant(
    category : ?Text,
    prefix : ?Text,
    limit : Nat,
  ) : async [Types.MemoryEntry] {
    assert (caller == owner);
    var result : [Types.MemoryEntry] = [];
    for ((_, entry) in Trie.iter(memories)) {
      if (result.size() < limit) {
        let catMatch = switch (category) {
          case (?c) { entry.category == c };
          case null { true };
        };
        let prefixMatch = switch (prefix) {
          case (?p) { Text.startsWith(entry.key, #text p) };
          case null { true };
        };
        if (catMatch and prefixMatch) {
          result := Array.append(result, [entry]);
        };
      };
    };
    result;
  };

  /// Sync manifest: checksums for differential sync.
  public composite query ({ caller }) func getSyncManifest() : async Types.SyncManifest {
    assert (caller == owner);
    let cats = getUniqueCategories();
    let checksums = Array.map<Text, (Text, Text)>(cats, func(cat) {
      (cat, categoryChecksum(cat));
    });
    {
      lastUpdated = lastUpdated;
      memoriesCount = memoriesCount;
      sessionsCount = sessionsCount;
      categoryChecksums = checksums;
    };
  };
};
