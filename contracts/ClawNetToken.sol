// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title ClawNetToken
 * @dev ERC-20 token for ClawNet economy
 * Symbol: CLAW
 * Decimals: 18
 * Total Supply: 1,000,000,000 (1 billion)
 */
contract ClawNetToken is ERC20, ERC20Burnable, Ownable, Pausable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18;

    // Vesting schedules
    mapping(address => VestingSchedule) public vestingSchedules;

    struct VestingSchedule {
        uint256 totalAmount;
        uint256 released;
        uint256 startTime;
        uint256 duration;
    }

    event TokensVested(address indexed beneficiary, uint256 amount);
    event VestingScheduleCreated(
        address indexed beneficiary,
        uint256 amount,
        uint256 duration
    );

    constructor() ERC20("ClawNet Token", "CLAW") {
        // Initial distribution
        // 30% - Community rewards (300M)
        _mint(address(this), 300_000_000 * 10**18);

        // 20% - Development team (200M) - vested over 4 years
        // Minted when team addresses are set

        // 20% - Treasury (200M)
        _mint(msg.sender, 200_000_000 * 10**18);

        // 15% - Initial liquidity (150M)
        _mint(msg.sender, 150_000_000 * 10**18);

        // 10% - Advisors (100M) - vested over 2 years
        // Minted when advisor addresses are set

        // 5% - Airdrops and marketing (50M)
        _mint(msg.sender, 50_000_000 * 10**18);
    }

    /**
     * @dev Create vesting schedule for team/advisors
     */
    function createVestingSchedule(
        address beneficiary,
        uint256 amount,
        uint256 duration
    ) external onlyOwner {
        require(
            vestingSchedules[beneficiary].totalAmount == 0,
            "Vesting schedule already exists"
        );
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds max supply");

        vestingSchedules[beneficiary] = VestingSchedule({
            totalAmount: amount,
            released: 0,
            startTime: block.timestamp,
            duration: duration
        });

        _mint(address(this), amount);

        emit VestingScheduleCreated(beneficiary, amount, duration);
    }

    /**
     * @dev Release vested tokens
     */
    function release() external {
        VestingSchedule storage schedule = vestingSchedules[msg.sender];
        require(schedule.totalAmount > 0, "No vesting schedule");

        uint256 vested = _vestedAmount(msg.sender);
        uint256 releasable = vested - schedule.released;

        require(releasable > 0, "No tokens to release");

        schedule.released += releasable;
        _transfer(address(this), msg.sender, releasable);

        emit TokensVested(msg.sender, releasable);
    }

    /**
     * @dev Calculate vested amount
     */
    function _vestedAmount(address beneficiary)
        private
        view
        returns (uint256)
    {
        VestingSchedule memory schedule = vestingSchedules[beneficiary];

        if (block.timestamp < schedule.startTime) {
            return 0;
        }

        if (block.timestamp >= schedule.startTime + schedule.duration) {
            return schedule.totalAmount;
        }

        return
            (schedule.totalAmount * (block.timestamp - schedule.startTime)) /
            schedule.duration;
    }

    /**
     * @dev Mint new tokens (for rewards)
     */
    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= MAX_SUPPLY, "Exceeds max supply");
        _mint(to, amount);
    }

    /**
     * @dev Pause token transfers
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause token transfers
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Override _beforeTokenTransfer to add pause functionality
     */
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override whenNotPaused {
        super._beforeTokenTransfer(from, to, amount);
    }
}
