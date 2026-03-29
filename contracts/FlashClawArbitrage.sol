// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(uint amountIn, address[] memory path)
        external view returns (uint[] memory amounts);
}

/**
 * @title FlashClawArbitrage
 * @notice Executes arbitrage using Aave V3 flashloans
 * @dev This contract receives a flashloan, executes arbitrage across DEXes, and repays the loan
 */
contract FlashClawArbitrage is FlashLoanSimpleReceiverBase {
    address public owner;

    struct ArbitrageParams {
        address[] path;           // Token swap path
        address[] routers;        // DEX routers to use
        uint256[] minAmountsOut;  // Minimum amounts for each swap
    }

    event ArbitrageExecuted(
        address indexed asset,
        uint256 amount,
        uint256 profit
    );

    event ArbitrageFailed(
        address indexed asset,
        uint256 amount,
        string reason
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _addressProvider)
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider))
    {
        owner = msg.sender;
    }

    /**
     * @notice Initiate a flashloan arbitrage
     * @param asset The address of the token to flashloan
     * @param amount The amount to borrow
     * @param params Encoded arbitrage parameters
     */
    function executeArbitrage(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0  // referralCode
        );
    }

    /**
     * @notice Aave flashloan callback function
     * @param asset The address of the flashloaned asset
     * @param amount The amount of the flashloaned asset
     * @param premium The fee for the flashloan
     * @param initiator The address that initiated the flashloan
     * @param params Encoded arbitrage parameters
     * @return bool Success status
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Caller must be POOL");
        require(initiator == address(this), "Initiator must be this contract");

        // Decode arbitrage parameters
        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));

        require(arbParams.path.length >= 2, "Invalid path");
        require(arbParams.routers.length == arbParams.path.length - 1, "Invalid routers");
        require(arbParams.minAmountsOut.length == arbParams.path.length - 1, "Invalid minAmounts");

        // Execute arbitrage
        uint256 finalAmount = _executeSwaps(amount, arbParams);

        // Calculate required repayment
        uint256 amountOwed = amount + premium;

        // Check profitability
        require(finalAmount >= amountOwed, "Arbitrage not profitable");

        // Approve repayment
        IERC20(asset).approve(address(POOL), amountOwed);

        // Calculate and emit profit
        uint256 profit = finalAmount - amountOwed;
        emit ArbitrageExecuted(asset, amount, profit);

        // Transfer profit to owner
        if (profit > 0) {
            IERC20(asset).transfer(owner, profit);
        }

        return true;
    }

    /**
     * @notice Execute swaps across multiple DEXes
     * @param initialAmount The starting amount
     * @param params Arbitrage parameters
     * @return finalAmount The final amount after all swaps
     */
    function _executeSwaps(
        uint256 initialAmount,
        ArbitrageParams memory params
    ) internal returns (uint256 finalAmount) {
        uint256 currentAmount = initialAmount;

        for (uint256 i = 0; i < params.routers.length; i++) {
            address[] memory path = new address[](2);
            path[0] = params.path[i];
            path[1] = params.path[i + 1];

            // Approve router to spend tokens
            IERC20(path[0]).approve(params.routers[i], currentAmount);

            // Execute swap
            uint[] memory amounts = IUniswapV2Router(params.routers[i])
                .swapExactTokensForTokens(
                    currentAmount,
                    params.minAmountsOut[i],
                    path,
                    address(this),
                    block.timestamp + 300  // 5 minute deadline
                );

            currentAmount = amounts[amounts.length - 1];
        }

        return currentAmount;
    }

    /**
     * @notice Simulate arbitrage to check profitability
     * @param asset The flashloan asset
     * @param amount The flashloan amount
     * @param params Encoded arbitrage parameters
     * @return profitable Whether the arbitrage would be profitable
     * @return expectedProfit The expected profit amount
     */
    function simulateArbitrage(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external view returns (bool profitable, uint256 expectedProfit) {
        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));

        uint256 currentAmount = amount;

        // Simulate swaps
        for (uint256 i = 0; i < arbParams.routers.length; i++) {
            address[] memory path = new address[](2);
            path[0] = arbParams.path[i];
            path[1] = arbParams.path[i + 1];

            uint[] memory amounts = IUniswapV2Router(arbParams.routers[i])
                .getAmountsOut(currentAmount, path);

            currentAmount = amounts[amounts.length - 1];
        }

        // Calculate repayment amount (amount + 0.09% premium)
        uint256 premium = (amount * 9) / 10000;
        uint256 amountOwed = amount + premium;

        if (currentAmount > amountOwed) {
            return (true, currentAmount - amountOwed);
        } else {
            return (false, 0);
        }
    }

    /**
     * @notice Withdraw any tokens stuck in the contract
     * @param token The token address
     * @param amount The amount to withdraw
     */
    function withdrawToken(
        address token,
        uint256 amount
    ) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    /**
     * @notice Withdraw ETH from the contract
     */
    function withdrawETH() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    /**
     * @notice Update contract owner
     * @param newOwner The new owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid address");
        owner = newOwner;
    }

    // Allow contract to receive ETH
    receive() external payable {}
}
