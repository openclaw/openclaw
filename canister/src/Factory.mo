import Types "Types";
import Array "mo:base/Array";
import Nat "mo:base/Nat";
import Principal "mo:base/Principal";
import Result "mo:base/Result";
import ExperimentalCycles "mo:base/ExperimentalCycles";

import UserVault "UserVault";

/// Factory canister that spawns per-user UserVault canisters.
/// Launcher, not landlord -- creates vault, then transfers control to the user.
/// Uses stable arrays (not Buffer) for EOP compatibility.
persistent actor Factory {

  // -- IC management canister interface (subset for controller transfer) --

  let ic : actor {
    update_settings : shared {
      canister_id : Principal;
      settings : {
        controllers : ?[Principal];
        compute_allocation : ?Nat;
        memory_allocation : ?Nat;
        freezing_threshold : ?Nat;
      };
    } -> async ();
  } = actor "aaaaa-aa";

  // -- Configuration --

  // Cycles to seed each new vault with (1.2T cycles ~= $1.56)
  // IC requires ~1.1T for canister installation as of 2026
  let VAULT_CREATION_CYCLES : Nat = 1_200_000_000_000;

  // Admin principal (deployer) -- set once via claimAdmin, then immutable.
  var admin : ?Principal = null;

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

    // Store the mapping first so a trap in update_settings doesn't orphan
    // the vault. The owner can retry controller transfer via transferController.
    vaults := Array.append(vaults, [(caller, canisterId)]);
    totalCreated += 1;

    // Transfer IC-level controller to the user (+ keep Factory for future ops)
    let factoryPrincipal = Principal.fromActor(Factory);
    await ic.update_settings({
      canister_id = canisterId;
      settings = {
        controllers = ?[caller, factoryPrincipal];
        compute_allocation = null;
        memory_allocation = null;
        freezing_threshold = null;
      };
    });

    #ok(canisterId);
  };

  /// Transfer IC-level controller of a vault to its owner.
  /// Sets controllers to [owner, Factory] so the owner can upgrade their own
  /// vault directly, while Factory retains access for future operations.
  /// Only the vault owner can call this.
  public shared ({ caller }) func transferController() : async Result.Result<(), Types.FactoryError> {
    if (Principal.isAnonymous(caller)) {
      return #err(#creationFailed("Anonymous callers cannot transfer controllers"));
    };

    switch (findVault(caller)) {
      case null { return #err(#creationFailed("No vault found for caller")) };
      case (?vaultId) {
        let factoryPrincipal = Principal.fromActor(Factory);
        await ic.update_settings({
          canister_id = vaultId;
          settings = {
            controllers = ?[caller, factoryPrincipal];
            compute_allocation = null;
            memory_allocation = null;
            freezing_threshold = null;
          };
        });
        #ok(());
      };
    };
  };

  // -- Admin functions --

  /// Claim admin role. Can only be called once (when admin is unset).
  /// Call immediately after deployment to secure the Factory.
  public shared ({ caller }) func claimAdmin() : async Result.Result<(), Types.FactoryError> {
    if (Principal.isAnonymous(caller)) {
      return #err(#creationFailed("Anonymous callers cannot claim admin"));
    };
    switch (admin) {
      case (?_) { #err(#creationFailed("Admin already set")) };
      case null {
        admin := ?caller;
        #ok(());
      };
    };
  };

  /// Re-register an existing vault mapping (admin-only recovery).
  /// Use after a Factory upgrade that lost state.
  public shared ({ caller }) func adminRegisterVault(
    owner : Principal,
    vaultId : Principal,
  ) : async Result.Result<(), Types.FactoryError> {
    switch (admin) {
      case (?a) {
        if (caller != a) {
          return #err(#creationFailed("Only admin can register vaults"));
        };
      };
      case null {
        return #err(#creationFailed("Admin not set -- call claimAdmin first"));
      };
    };

    // Don't allow duplicate registrations for the same owner
    switch (findVault(owner)) {
      case (?_) { return #err(#alreadyExists) };
      case null {};
    };

    vaults := Array.append(vaults, [(owner, vaultId)]);
    totalCreated += 1;
    #ok(());
  };

  /// Get the current admin principal.
  public query func getAdmin() : async ?Principal {
    admin;
  };

  // -- Public queries --

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
