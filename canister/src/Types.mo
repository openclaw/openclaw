/// Shared types for IC Memory Vault canisters.
/// Used by both Factory and UserVault.
module Types {

  // -- Audit log --

  /// Actions recorded in the immutable audit log
  public type AuditAction = {
    #store;        // memory stored or updated
    #delete;       // memory deleted
    #bulkSync;     // batch sync operation
    #restore;      // data restored from vault
    #created;      // vault created
    #accessDenied; // unauthorized access attempt
  };

  /// Immutable record of a vault operation.
  /// Appended to the audit log via update calls (consensus-verified timestamp).
  public type AuditEntry = {
    timestamp : Int;       // IC consensus time via Time.now()
    action : AuditAction;
    caller : Principal;    // who performed the action
    key : ?Text;           // affected key (if applicable)
    category : ?Text;      // affected category (if applicable)
    details : ?Text;       // additional context (e.g., "synced 47 entries")
  };

  // -- Memory --

  /// A single memory entry stored in the vault
  public type MemoryEntry = {
    key : Text;
    category : Text;
    content : Blob;
    metadata : Text;   // JSON string for flexible metadata
    createdAt : Int;
    updatedAt : Int;
  };

  // -- Sessions --

  /// A session record
  public type SessionEntry = {
    sessionId : Text;
    data : Blob;
    startedAt : Int;
    endedAt : Int;
  };

  // -- Stats and sync --

  /// Vault statistics
  public type VaultStats = {
    totalMemories : Nat;
    totalSessions : Nat;
    categories : [Text];
    bytesUsed : Nat;
    cycleBalance : Nat;
    lastUpdated : Int;
  };

  /// Manifest for differential sync
  public type SyncManifest = {
    lastUpdated : Int;
    memoriesCount : Nat;
    sessionsCount : Nat;
    categoryChecksums : [(Text, Text)];
  };

  /// Dashboard data returned by composite query
  public type DashboardData = {
    stats : VaultStats;
    recentMemories : [MemoryEntry];
    recentSessions : [SessionEntry];
  };

  /// Result of a bulk sync operation
  public type SyncResult = {
    stored : Nat;
    skipped : Nat;
    errors : [Text];
  };

  // -- Input types for bulk operations --

  /// Input for a single memory to store/sync
  public type MemoryInput = {
    key : Text;
    category : Text;
    content : Blob;
    metadata : Text;
    createdAt : Int;
    updatedAt : Int;
  };

  /// Input for a session to sync
  public type SessionInput = {
    sessionId : Text;
    data : Blob;
    startedAt : Int;
    endedAt : Int;
  };

  // -- Error types --

  /// Errors returned by the factory
  public type FactoryError = {
    #alreadyExists;          // user already has a vault
    #insufficientCycles;     // not enough cycles to create a vault
    #unauthorized : Text;    // caller not permitted for this operation
    #notFound : Text;        // requested resource not found
    #creationFailed : Text;  // vault creation failed
  };

  /// Errors returned by the vault
  public type VaultError = {
    #unauthorized;
    #notFound;
    #invalidInput : Text;
  };
};
