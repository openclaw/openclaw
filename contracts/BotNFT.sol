// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

/**
 * @title BotNFT
 * @dev ERC-721 NFT representing AI bot ownership
 * Each bot is a unique NFT with metadata
 */
contract BotNFT is ERC721, ERC721URIStorage, ERC721Enumerable, Ownable {
    using Counters for Counters.Counter;
    Counters.Counter private _tokenIdCounter;

    uint256 public constant MINT_PRICE = 100 * 10**18; // 100 CLAW tokens

    struct BotMetadata {
        string name;
        string agentType; // assistant, creative, technical, etc.
        string modelInfo; // Claude Opus 4.5, etc.
        uint256 creationDate;
        address creator;
        uint256 totalEarnings; // Lifetime earnings in CLAW
        uint256 totalInteractions; // Total user interactions
    }

    mapping(uint256 => BotMetadata) public bots;

    // Bot performance metrics
    mapping(uint256 => uint256) public botRatings; // Average rating (0-5) * 100
    mapping(uint256 => uint256) public botRatingCount;

    event BotMinted(
        uint256 indexed tokenId,
        address indexed creator,
        string name,
        string agentType
    );
    event BotRated(uint256 indexed tokenId, uint256 rating);
    event EarningsUpdated(uint256 indexed tokenId, uint256 earnings);

    constructor() ERC721("ClawNet Bot", "CLAWBOT") {}

    /**
     * @dev Mint new bot NFT
     */
    function mintBot(
        address to,
        string memory name,
        string memory agentType,
        string memory modelInfo,
        string memory tokenURI
    ) external returns (uint256) {
        uint256 tokenId = _tokenIdCounter.current();
        _tokenIdCounter.increment();

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenURI);

        bots[tokenId] = BotMetadata({
            name: name,
            agentType: agentType,
            modelInfo: modelInfo,
            creationDate: block.timestamp,
            creator: to,
            totalEarnings: 0,
            totalInteractions: 0
        });

        emit BotMinted(tokenId, to, name, agentType);

        return tokenId;
    }

    /**
     * @dev Update bot earnings
     */
    function updateEarnings(uint256 tokenId, uint256 earnings)
        external
        onlyOwner
    {
        require(_exists(tokenId), "Bot does not exist");
        bots[tokenId].totalEarnings += earnings;
        emit EarningsUpdated(tokenId, bots[tokenId].totalEarnings);
    }

    /**
     * @dev Update bot interactions count
     */
    function incrementInteractions(uint256 tokenId) external onlyOwner {
        require(_exists(tokenId), "Bot does not exist");
        bots[tokenId].totalInteractions++;
    }

    /**
     * @dev Rate a bot (1-5 stars)
     */
    function rateBot(uint256 tokenId, uint256 rating) external {
        require(_exists(tokenId), "Bot does not exist");
        require(rating >= 1 && rating <= 5, "Rating must be 1-5");

        uint256 currentTotal = botRatings[tokenId];
        uint256 currentCount = botRatingCount[tokenId];

        // Calculate new average
        botRatings[tokenId] =
            ((currentTotal * currentCount) + (rating * 100)) /
            (currentCount + 1);
        botRatingCount[tokenId]++;

        emit BotRated(tokenId, rating);
    }

    /**
     * @dev Get bot rating
     */
    function getBotRating(uint256 tokenId)
        external
        view
        returns (uint256 rating, uint256 count)
    {
        return (botRatings[tokenId], botRatingCount[tokenId]);
    }

    /**
     * @dev Get bot metadata
     */
    function getBotMetadata(uint256 tokenId)
        external
        view
        returns (BotMetadata memory)
    {
        require(_exists(tokenId), "Bot does not exist");
        return bots[tokenId];
    }

    /**
     * @dev Get all bots owned by an address
     */
    function getOwnedBots(address owner)
        external
        view
        returns (uint256[] memory)
    {
        uint256 balance = balanceOf(owner);
        uint256[] memory tokenIds = new uint256[](balance);

        for (uint256 i = 0; i < balance; i++) {
            tokenIds[i] = tokenOfOwnerByIndex(owner, i);
        }

        return tokenIds;
    }

    // Required overrides for multiple inheritance

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override(ERC721, ERC721Enumerable) {
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
    }

    function _burn(uint256 tokenId)
        internal
        override(ERC721, ERC721URIStorage)
    {
        super._burn(tokenId);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
