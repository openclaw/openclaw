// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./BotNFT.sol";
import "./ClawNetToken.sol";

/**
 * @title BotMarketplace
 * @dev Marketplace for buying, selling, and renting AI bots
 */
contract BotMarketplace is ReentrancyGuard, Ownable {
    BotNFT public botNFT;
    ClawNetToken public clawToken;

    uint256 public constant PLATFORM_FEE_PERCENTAGE = 5; // 5% fee
    uint256 public constant RENTAL_PLATFORM_FEE_PERCENTAGE = 10; // 10% fee for rentals

    struct Listing {
        address seller;
        uint256 price;
        bool isActive;
        uint256 listedAt;
    }

    struct RentalListing {
        address owner;
        uint256 pricePerDay;
        bool isActive;
        uint256 maxRentalDays;
    }

    struct ActiveRental {
        address renter;
        uint256 startTime;
        uint256 endTime;
        uint256 totalPaid;
    }

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => RentalListing) public rentalListings;
    mapping(uint256 => ActiveRental) public activeRentals;

    // Revenue tracking
    mapping(address => uint256) public sellerEarnings;
    mapping(address => uint256) public ownerRentalEarnings;
    uint256 public platformEarnings;

    event BotListed(uint256 indexed tokenId, address seller, uint256 price);
    event BotUnlisted(uint256 indexed tokenId);
    event BotSold(
        uint256 indexed tokenId,
        address seller,
        address buyer,
        uint256 price
    );
    event BotListedForRent(
        uint256 indexed tokenId,
        address owner,
        uint256 pricePerDay
    );
    event BotRented(
        uint256 indexed tokenId,
        address renter,
        uint256 days,
        uint256 totalPrice
    );
    event RentalEnded(uint256 indexed tokenId, address renter);
    event EarningsWithdrawn(address indexed user, uint256 amount);

    constructor(address _botNFT, address _clawToken) {
        botNFT = BotNFT(_botNFT);
        clawToken = ClawNetToken(_clawToken);
    }

    /**
     * @dev List bot for sale
     */
    function listBot(uint256 tokenId, uint256 price) external nonReentrant {
        require(botNFT.ownerOf(tokenId) == msg.sender, "Not bot owner");
        require(price > 0, "Price must be > 0");
        require(!listings[tokenId].isActive, "Already listed");

        // Transfer NFT to marketplace (escrow)
        botNFT.transferFrom(msg.sender, address(this), tokenId);

        listings[tokenId] = Listing({
            seller: msg.sender,
            price: price,
            isActive: true,
            listedAt: block.timestamp
        });

        emit BotListed(tokenId, msg.sender, price);
    }

    /**
     * @dev Unlist bot from sale
     */
    function unlistBot(uint256 tokenId) external nonReentrant {
        Listing storage listing = listings[tokenId];
        require(listing.isActive, "Not listed");
        require(listing.seller == msg.sender, "Not seller");

        // Return NFT to seller
        botNFT.transferFrom(address(this), msg.sender, tokenId);

        listing.isActive = false;

        emit BotUnlisted(tokenId);
    }

    /**
     * @dev Buy bot
     */
    function buyBot(uint256 tokenId) external nonReentrant {
        Listing storage listing = listings[tokenId];
        require(listing.isActive, "Not for sale");
        require(msg.sender != listing.seller, "Cannot buy own bot");

        uint256 price = listing.price;
        uint256 platformFee = (price * PLATFORM_FEE_PERCENTAGE) / 100;
        uint256 sellerAmount = price - platformFee;

        // Transfer CLAW tokens
        require(
            clawToken.transferFrom(msg.sender, address(this), price),
            "Token transfer failed"
        );

        // Update earnings
        sellerEarnings[listing.seller] += sellerAmount;
        platformEarnings += platformFee;

        // Transfer NFT to buyer
        botNFT.transferFrom(address(this), msg.sender, tokenId);

        // Remove listing
        listing.isActive = false;

        emit BotSold(tokenId, listing.seller, msg.sender, price);
    }

    /**
     * @dev List bot for rent
     */
    function listBotForRent(uint256 tokenId, uint256 pricePerDay, uint256 maxDays)
        external
    {
        require(botNFT.ownerOf(tokenId) == msg.sender, "Not bot owner");
        require(pricePerDay > 0, "Price must be > 0");
        require(maxDays > 0 && maxDays <= 365, "Invalid max days");
        require(
            activeRentals[tokenId].renter == address(0),
            "Bot is currently rented"
        );

        rentalListings[tokenId] = RentalListing({
            owner: msg.sender,
            pricePerDay: pricePerDay,
            isActive: true,
            maxRentalDays: maxDays
        });

        emit BotListedForRent(tokenId, msg.sender, pricePerDay);
    }

    /**
     * @dev Unlist bot from rental
     */
    function unlistBotFromRental(uint256 tokenId) external {
        RentalListing storage rental = rentalListings[tokenId];
        require(rental.isActive, "Not listed for rent");
        require(rental.owner == msg.sender, "Not owner");
        require(
            activeRentals[tokenId].renter == address(0),
            "Bot is currently rented"
        );

        rental.isActive = false;
    }

    /**
     * @dev Rent bot
     */
    function rentBot(uint256 tokenId, uint256 days) external nonReentrant {
        RentalListing storage rental = rentalListings[tokenId];
        require(rental.isActive, "Not available for rent");
        require(days > 0 && days <= rental.maxRentalDays, "Invalid rental period");
        require(
            activeRentals[tokenId].renter == address(0),
            "Already rented"
        );
        require(msg.sender != rental.owner, "Cannot rent own bot");

        uint256 totalPrice = rental.pricePerDay * days;
        uint256 platformFee = (totalPrice * RENTAL_PLATFORM_FEE_PERCENTAGE) / 100;
        uint256 ownerAmount = totalPrice - platformFee;

        // Transfer CLAW tokens
        require(
            clawToken.transferFrom(msg.sender, address(this), totalPrice),
            "Token transfer failed"
        );

        // Update earnings
        ownerRentalEarnings[rental.owner] += ownerAmount;
        platformEarnings += platformFee;

        // Create rental record
        activeRentals[tokenId] = ActiveRental({
            renter: msg.sender,
            startTime: block.timestamp,
            endTime: block.timestamp + (days * 1 days),
            totalPaid: totalPrice
        });

        emit BotRented(tokenId, msg.sender, days, totalPrice);
    }

    /**
     * @dev End rental (called after expiry)
     */
    function endRental(uint256 tokenId) external {
        ActiveRental storage rental = activeRentals[tokenId];
        require(rental.renter != address(0), "No active rental");
        require(block.timestamp >= rental.endTime, "Rental not expired");

        address renter = rental.renter;

        // Clear rental
        delete activeRentals[tokenId];

        emit RentalEnded(tokenId, renter);
    }

    /**
     * @dev Check if bot is currently rented
     */
    function isRented(uint256 tokenId) external view returns (bool) {
        ActiveRental memory rental = activeRentals[tokenId];
        return
            rental.renter != address(0) && block.timestamp < rental.endTime;
    }

    /**
     * @dev Get current renter of bot
     */
    function getCurrentRenter(uint256 tokenId)
        external
        view
        returns (address)
    {
        ActiveRental memory rental = activeRentals[tokenId];
        if (rental.renter != address(0) && block.timestamp < rental.endTime) {
            return rental.renter;
        }
        return address(0);
    }

    /**
     * @dev Withdraw seller earnings
     */
    function withdrawSellerEarnings() external nonReentrant {
        uint256 amount = sellerEarnings[msg.sender];
        require(amount > 0, "No earnings");

        sellerEarnings[msg.sender] = 0;
        require(clawToken.transfer(msg.sender, amount), "Transfer failed");

        emit EarningsWithdrawn(msg.sender, amount);
    }

    /**
     * @dev Withdraw rental earnings
     */
    function withdrawRentalEarnings() external nonReentrant {
        uint256 amount = ownerRentalEarnings[msg.sender];
        require(amount > 0, "No earnings");

        ownerRentalEarnings[msg.sender] = 0;
        require(clawToken.transfer(msg.sender, amount), "Transfer failed");

        emit EarningsWithdrawn(msg.sender, amount);
    }

    /**
     * @dev Withdraw platform earnings (owner only)
     */
    function withdrawPlatformEarnings() external onlyOwner nonReentrant {
        uint256 amount = platformEarnings;
        require(amount > 0, "No earnings");

        platformEarnings = 0;
        require(clawToken.transfer(msg.sender, amount), "Transfer failed");

        emit EarningsWithdrawn(msg.sender, amount);
    }

    /**
     * @dev Get total earnings for a user
     */
    function getTotalEarnings(address user) external view returns (uint256) {
        return sellerEarnings[user] + ownerRentalEarnings[user];
    }
}
