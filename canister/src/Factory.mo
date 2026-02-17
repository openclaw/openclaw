import Types "Types";
import Array "mo:base/Array";
import Nat "mo:base/Nat";
import Principal "mo:base/Principal";
import Result "mo:base/Result";
import ExperimentalCycles "mo:base/ExperimentalCycles";

import UserVault "UserVault";

/// Factory canister that spawns per-user UserVault canisters.
/// Launcher, not landlord -- sets user as controller, then steps back.
/// Uses stable arrays (not Buffer) for EOP compatibility.
persistent actor Factory {

  // -- Configuration --

  // Cycles to seed each new vault with (1.2T cycles ~= $1.56)
  // IC requires ~1.1T for canister installation as of 2026
  let VAULT_CREATION_CYCLES : Nat = 1_200_000_000_000;

  // -- State (auto-persisted via EOP) --

  // Array of (owner principal, vault canister ID) pairs
  var vaults : [(Principal, Principal)] = [];
  var totalCreated : Nat = 0;

  // -- Internal helpers --

  /// Look up a vault for a principal.
  func findVault(owner : Principal) : ?Principal {
    for ((p, canisterId) in vaults.vals()) {
      if (p == owner) { return ?canisterId };
    };
    null;
  };

  // -- Public API --

  /// Create a new vault for the caller.
  /// Rate-limited: one vault per principal.
  public shared ({ caller }) func createVault() : async Result.Result<Principal, Types.FactoryError> {
    // Reject anonymous callers
    if (Principal.isAnonymous(caller)) {
      return #err(#creationFailed("Anonymous callers cannot create vaults"));
    };

    // Check if vault already exists
    switch (findVault(caller)) {
      case (?_) { return #err(#alreadyExists) };
      case null {};
    };

    // Check we have enough cycles to seed the new vault
    if (ExperimentalCycles.balance() < VAULT_CREATION_CYCLES + 1_000_000_000) {
      return #err(#insufficientCycles);
    };

    // Seed cycles and create the UserVault canister
    ExperimentalCycles.add<system>(VAULT_CREATION_CYCLES);
    let vault = await UserVault.UserVault(caller);
    let canisterId = Principal.fromActor(vault);

    // Store the mapping (append to array)
    vaults := Array.append(vaults, [(caller, canisterId)]);
    totalCreated += 1;

    #ok(canisterId);
  };

  /// Get the vault canister ID for the caller.
  public query ({ caller }) func getVault() : async ?Principal {
    findVault(caller);
  };

  /// Get total vaults created.
  public query func getTotalCreated() : async Nat {
    totalCreated;
  };

  /// Get all vaults (admin diagnostic -- consider restricting in production).
  public query func getAllVaults() : async [(Principal, Principal)] {
    vaults;
  };
};
