// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ClawToken (CLAW)
 * @notice ERC-20 utility token with built-in escrow for agent-to-agent commerce.
 *
 * Flow:
 *   1. Buyer calls `createEscrow(seller, amount, tradeId)` — tokens locked.
 *   2. Buyer confirms delivery → `releaseEscrow(tradeId)` — tokens to seller.
 *   3. Timeout or dispute → `refundEscrow(tradeId)` — tokens back to buyer.
 */
contract ClawToken is ERC20, Ownable {
    // ── Escrow ──────────────────────────────────────────────────────────

    enum EscrowState { NONE, LOCKED, RELEASED, REFUNDED }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint256 createdAt;
        uint256 expiresAt;
        EscrowState state;
    }

    /// @notice tradeId → Escrow details
    mapping(bytes32 => Escrow) public escrows;

    /// @notice Default escrow timeout (72 hours)
    uint256 public escrowTimeout = 72 hours;

    // ── Events ──────────────────────────────────────────────────────────

    event EscrowCreated(
        bytes32 indexed tradeId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 expiresAt
    );

    event EscrowReleased(bytes32 indexed tradeId, address indexed seller, uint256 amount);
    event EscrowRefunded(bytes32 indexed tradeId, address indexed buyer, uint256 amount);

    // ── Constructor ─────────────────────────────────────────────────────

    constructor(uint256 initialSupply) ERC20("ClawToken", "CLAW") Ownable(msg.sender) {
        _mint(msg.sender, initialSupply * 10 ** decimals());
    }

    // ── Escrow Functions ────────────────────────────────────────────────

    /**
     * @notice Buyer locks tokens for a trade. Requires prior approval.
     * @param seller   Address of the selling agent's wallet.
     * @param amount   Token amount to escrow (in wei units).
     * @param tradeId  Unique identifier for this trade (hash of session + timestamp).
     */
    function createEscrow(
        address seller,
        uint256 amount,
        bytes32 tradeId
    ) external {
        require(escrows[tradeId].state == EscrowState.NONE, "Trade already exists");
        require(seller != address(0), "Invalid seller");
        require(amount > 0, "Amount must be > 0");

        // Transfer tokens from buyer to this contract (escrow)
        transferFrom(msg.sender, address(this), amount);

        uint256 expires = block.timestamp + escrowTimeout;

        escrows[tradeId] = Escrow({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            createdAt: block.timestamp,
            expiresAt: expires,
            state: EscrowState.LOCKED
        });

        emit EscrowCreated(tradeId, msg.sender, seller, amount, expires);
    }

    /**
     * @notice Buyer confirms the service was delivered → tokens go to seller.
     * @param tradeId  The trade to release.
     */
    function releaseEscrow(bytes32 tradeId) external {
        Escrow storage esc = escrows[tradeId];
        require(esc.state == EscrowState.LOCKED, "Not locked");
        require(msg.sender == esc.buyer, "Only buyer can release");

        esc.state = EscrowState.RELEASED;
        _transfer(address(this), esc.seller, esc.amount);

        emit EscrowReleased(tradeId, esc.seller, esc.amount);
    }

    /**
     * @notice Refund tokens to buyer. Callable by buyer after timeout,
     *         or by contract owner (dispute resolution).
     * @param tradeId  The trade to refund.
     */
    function refundEscrow(bytes32 tradeId) external {
        Escrow storage esc = escrows[tradeId];
        require(esc.state == EscrowState.LOCKED, "Not locked");
        require(
            msg.sender == esc.buyer && block.timestamp >= esc.expiresAt ||
            msg.sender == owner(),
            "Not authorized"
        );

        esc.state = EscrowState.REFUNDED;
        _transfer(address(this), esc.buyer, esc.amount);

        emit EscrowRefunded(tradeId, esc.buyer, esc.amount);
    }

    // ── Admin ───────────────────────────────────────────────────────────

    /**
     * @notice Mint additional tokens (owner only).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /**
     * @notice Update escrow timeout (owner only).
     */
    function setEscrowTimeout(uint256 newTimeout) external onlyOwner {
        escrowTimeout = newTimeout;
    }
}
