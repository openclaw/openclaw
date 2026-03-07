"""
DeFi Researcher Agent

Cryptocurrency and DeFi research agent for market analysis and blockchain insights.
Demonstrates a crypto domain agent with read-only risk level.
"""

import re
from typing import Any, Dict, List, Optional
from datetime import datetime
import random

from engine.agents.base import BaseAgent


class DeFiResearcherAgent(BaseAgent):
    """
    DeFi and cryptocurrency research agent.
    
    Domain: crypto
    Risk Level: read_only (analysis only, no trading actions)
    """
    
    def __init__(self) -> None:
        super().__init__()
        self.demo_mode = True
        self.coingecko_api_key = None
    
    async def initialize(self, config: Dict[str, Any]) -> None:
        """Initialize with configuration"""
        self.demo_mode = config.get("demo_mode", True)
        self.coingecko_api_key = config.get("coingecko_api_key")
        self.mark_initialized()
    
    async def execute(self, task: str, context: Optional[Dict[str, Any]] = None) -> Any:
        """
        Execute a crypto research task.
        
        Supports:
        - "analyze [token/coin]"
        - "market trends"
        - "defi protocol [name]"
        - "price prediction [token]"
        - "explain [blockchain concept]"
        """
        task_lower = task.lower()
        
        try:
            if "analyze" in task_lower and ("token" in task_lower or "coin" in task_lower or len(task.split()) <= 3):
                token = self._extract_token(task)
                result = self._analyze_token(token)
            elif "market trends" in task_lower or "market analysis" in task_lower:
                result = self._get_market_trends()
            elif "defi protocol" in task_lower or "protocol" in task_lower:
                protocol = task.split("protocol")[-1].strip() if "protocol" in task_lower else "Uniswap"
                result = self._analyze_defi_protocol(protocol)
            elif "price prediction" in task_lower or "predict" in task_lower:
                token = self._extract_token(task)
                result = self._price_prediction(token)
            elif "explain" in task_lower:
                concept = task.split("explain")[-1].strip()
                result = self._explain_concept(concept)
            else:
                result = self._general_crypto_response(task)
            
            self.record_execution(success=True)
            return result
            
        except Exception as e:
            self.record_execution(success=False)
            raise
    
    def get_capabilities(self) -> List[str]:
        """Get agent capabilities"""
        return [
            "Analyze cryptocurrency market trends",
            "Research DeFi protocols and tokens",
            "Provide price analysis and predictions",
            "Identify trading opportunities",
            "Explain blockchain concepts",
            "Track NFT and Web3 trends",
        ]
    
    async def cleanup(self) -> None:
        """Cleanup resources"""
        pass
    
    # ========================================================================
    # Analysis Methods
    # ========================================================================
    
    def _extract_token(self, task: str) -> str:
        """Extract token name from task"""
        # Common crypto tokens
        tokens = ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "cardano", "ada", 
                  "polkadot", "dot", "avalanche", "avax", "polygon", "matic"]
        
        task_lower = task.lower()
        for token in tokens:
            if token in task_lower:
                return token.upper() if len(token) <= 4 else token.capitalize()
        
        # Extract word after "analyze" or "token"
        words = task.split()
        for i, word in enumerate(words):
            if word.lower() in ["analyze", "token", "coin"] and i + 1 < len(words):
                return words[i + 1].upper() if len(words[i + 1]) <= 4 else words[i + 1].capitalize()
        
        return "BTC"
    
    def _analyze_token(self, token: str) -> Dict[str, Any]:
        """Analyze a cryptocurrency token"""
        # Simulate token analysis
        price = random.uniform(100, 50000)
        change_24h = random.uniform(-15, 15)
        market_cap = random.uniform(1e9, 1e12)
        
        return {
            "type": "token_analysis",
            "token": token,
            "timestamp": datetime.now().isoformat(),
            "demo_mode": self.demo_mode,
            "price_data": {
                "current_price": f"${price:,.2f}",
                "change_24h": f"{change_24h:+.2f}%",
                "change_7d": f"{random.uniform(-20, 20):+.2f}%",
                "market_cap": f"${market_cap/1e9:.2f}B",
                "volume_24h": f"${random.uniform(1e8, 1e10)/1e9:.2f}B",
            },
            "technical_analysis": {
                "trend": "bullish" if change_24h > 0 else "bearish",
                "support_levels": [f"${price * 0.95:,.2f}", f"${price * 0.90:,.2f}"],
                "resistance_levels": [f"${price * 1.05:,.2f}", f"${price * 1.10:,.2f}"],
                "rsi": random.uniform(30, 70),
                "macd": "bullish cross" if random.random() > 0.5 else "bearish divergence",
            },
            "sentiment": {
                "overall": random.choice(["very bullish", "bullish", "neutral", "bearish"]),
                "social_volume": random.choice(["high", "moderate", "low"]),
                "fear_greed_index": random.randint(20, 80),
            },
            "recommendations": [
                f"Current trend is {('bullish' if change_24h > 0 else 'bearish')} - consider {'accumulating' if change_24h > 0 else 'holding'}",
                f"Watch key support at ${price * 0.95:,.2f}",
                f"Take profit opportunities near ${price * 1.10:,.2f}",
                "DYOR - This is not financial advice",
            ],
            "note": "Demo mode - using simulated data. Configure API keys for real analysis." if self.demo_mode else None,
        }
    
    def _get_market_trends(self) -> Dict[str, Any]:
        """Get current market trends"""
        return {
            "type": "market_trends",
            "timestamp": datetime.now().isoformat(),
            "overall_market": {
                "total_market_cap": f"${random.uniform(1.5e12, 2.5e12)/1e12:.2f}T",
                "btc_dominance": f"{random.uniform(40, 50):.1f}%",
                "eth_dominance": f"{random.uniform(15, 20):.1f}%",
                "defi_tvl": f"${random.uniform(40e9, 100e9)/1e9:.1f}B",
            },
            "trending_tokens": [
                {"name": "Bitcoin", "ticker": "BTC", "change": f"{random.uniform(-5, 10):+.2f}%"},
                {"name": "Ethereum", "ticker": "ETH", "change": f"{random.uniform(-5, 10):+.2f}%"},
                {"name": "Solana", "ticker": "SOL", "change": f"{random.uniform(-10, 20):+.2f}%"},
                {"name": "Avalanche", "ticker": "AVAX", "change": f"{random.uniform(-10, 15):+.2f}%"},
                {"name": "Polkadot", "ticker": "DOT", "change": f"{random.uniform(-8, 12):+.2f}%"},
            ],
            "sector_performance": {
                "DeFi": f"{random.uniform(-5, 15):+.2f}%",
                "Layer 1": f"{random.uniform(-3, 12):+.2f}%",
                "Layer 2": f"{random.uniform(-2, 18):+.2f}%",
                "NFT": f"{random.uniform(-15, 25):+.2f}%",
                "Meme Coins": f"{random.uniform(-20, 50):+.2f}%",
            },
            "market_sentiment": random.choice(["Extreme Greed", "Greed", "Neutral", "Fear", "Extreme Fear"]),
            "key_events": [
                "Bitcoin ETF seeing increased institutional inflows",
                "Major DeFi protocol announces v3 upgrade",
                "Regulatory clarity improving in key markets",
                "Layer 2 adoption reaching new highs",
            ],
        }
    
    def _analyze_defi_protocol(self, protocol: str) -> Dict[str, Any]:
        """Analyze a DeFi protocol"""
        return {
            "type": "defi_protocol_analysis",
            "protocol": protocol,
            "timestamp": datetime.now().isoformat(),
            "overview": {
                "tvl": f"${random.uniform(1e9, 20e9)/1e9:.2f}B",
                "users": f"{random.randint(100000, 5000000):,}",
                "chains": random.choice(["Multi-chain", "Ethereum only", "EVM compatible"]),
                "token_price": f"${random.uniform(1, 50):.2f}",
            },
            "metrics": {
                "volume_24h": f"${random.uniform(100e6, 5e9)/1e9:.2f}B",
                "fees_24h": f"${random.uniform(1e6, 50e6)/1e6:.2f}M",
                "revenue_share": f"{random.uniform(10, 30):.1f}% to token holders",
                "apy_range": f"{random.uniform(2, 15):.1f}% - {random.uniform(20, 100):.1f}%",
            },
            "risks": [
                "Smart contract risk - multiple audits completed",
                "Impermanent loss for liquidity providers",
                "Regulatory uncertainty",
                f"TVL concentration: {random.randint(30, 70)}% in top 3 pools",
            ],
            "opportunities": [
                f"Attractive yields on stablecoin pairs ({random.uniform(5, 15):.1f}% APY)",
                "Growing ecosystem with new partnerships",
                "Token incentive programs active",
                "Cross-chain expansion planned",
            ],
            "security_score": f"{random.randint(7, 10)}/10",
        }
    
    def _price_prediction(self, token: str) -> Dict[str, Any]:
        """Generate price prediction"""
        current_price = random.uniform(100, 50000)
        
        return {
            "type": "price_prediction",
            "token": token,
            "timestamp": datetime.now().isoformat(),
            "disclaimer": "⚠️ NOT FINANCIAL ADVICE - For educational purposes only",
            "current_price": f"${current_price:,.2f}",
            "predictions": {
                "7_days": {
                    "conservative": f"${current_price * random.uniform(0.95, 1.05):,.2f}",
                    "moderate": f"${current_price * random.uniform(0.90, 1.10):,.2f}",
                    "aggressive": f"${current_price * random.uniform(0.85, 1.15):,.2f}",
                },
                "30_days": {
                    "conservative": f"${current_price * random.uniform(0.90, 1.10):,.2f}",
                    "moderate": f"${current_price * random.uniform(0.80, 1.20):,.2f}",
                    "aggressive": f"${current_price * random.uniform(0.70, 1.40):,.2f}",
                },
                "90_days": {
                    "conservative": f"${current_price * random.uniform(0.85, 1.15):,.2f}",
                    "moderate": f"${current_price * random.uniform(0.70, 1.40):,.2f}",
                    "aggressive": f"${current_price * random.uniform(0.50, 2.00):,.2f}",
                },
            },
            "key_factors": [
                "Overall market sentiment and BTC correlation",
                "Protocol development and roadmap execution",
                "Regulatory developments",
                "Institutional adoption trends",
                "Market liquidity and volume",
            ],
            "confidence": random.choice(["Low", "Moderate", "High"]),
        }
    
    def _explain_concept(self, concept: str) -> Dict[str, Any]:
        """Explain blockchain/crypto concept"""
        concepts = {
            "defi": {
                "term": "DeFi (Decentralized Finance)",
                "definition": "Financial services built on blockchain technology without traditional intermediaries",
                "key_features": ["Permissionless", "Transparent", "Composable", "Non-custodial"],
                "examples": ["Uniswap (DEX)", "Aave (Lending)", "Compound (Borrowing)", "Curve (Stableswap)"],
            },
            "staking": {
                "term": "Staking",
                "definition": "Locking cryptocurrencies to support network operations and earn rewards",
                "key_features": ["Passive income", "Network security", "Governance rights", "Lock-up periods"],
                "examples": ["Ethereum 2.0", "Cardano", "Polkadot", "Cosmos"],
            },
            "yield farming": {
                "term": "Yield Farming",
                "definition": "Earning rewards by providing liquidity to DeFi protocols",
                "key_features": ["High APY potential", "Impermanent loss risk", "Multiple strategies", "Compounding"],
                "examples": ["Liquidity pools", "Lending protocols", "Yield aggregators", "Auto-compounders"],
            },
        }
        
        concept_lower = concept.lower()
        for key, data in concepts.items():
            if key in concept_lower:
                return {"type": "concept_explanation", **data}
        
        return {
            "type": "concept_explanation",
            "term": concept,
            "definition": f"Information about {concept} - search crypto educational resources for detailed explanations",
            "suggestion": "Try asking about: DeFi, staking, yield farming, NFTs, Layer 2, or smart contracts",
        }
    
    def _general_crypto_response(self, task: str) -> Dict[str, Any]:
        """General crypto response"""
        return {
            "type": "general",
            "task": task,
            "response": "I can help with crypto research! Try asking me to:\n"
                       "- Analyze [token name]\n"
                       "- Market trends\n"
                       "- DeFi protocol [name]\n"
                       "- Price prediction [token]\n"
                       "- Explain [concept]",
            "capabilities": self.get_capabilities(),
            "demo_mode": self.demo_mode,
        }


# Agent instance (will be loaded by the engine)
agent = DeFiResearcherAgent()
