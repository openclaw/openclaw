# Error Handling Reference

Resolve Bankr API errors and common issues.

## Authentication Errors

### Symptoms
- HTTP 401 status code
- "Invalid API key" or "Unauthorized" message
- "X-API-Key header is required"

### Resolution Steps

**1. Get API Key**
Visit https://bankr.bot/api to create a new API key

**2. Create Configuration**
```bash
mkdir -p ~/.clawdbot/skills/bankr
cat > ~/.clawdbot/skills/bankr/config.json << 'EOF'
{
  "apiKey": "bk_your_actual_key_here",
  "apiUrl": "https://api.bankr.bot"
}
EOF
```

**3. Verify Setup**
Test with a simple command:
```bash
~/.clawdbot/skills/bankr/scripts/bankr.sh "What is my balance?"
```

### Common API Key Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| "Invalid API key" | Wrong key or revoked | Generate new key |
| "Agent API not enabled" | Missing permission | Enable in API dashboard |
| "API key expired" | Old/inactive key | Create new key |
| "Rate limit exceeded" | Too many requests | Wait or upgrade plan |

## Job Failures

### Transaction Failures

**Insufficient Balance**
- **Error**: "Insufficient balance for trade"
- **Cause**: Not enough tokens or gas
- **Fix**: Add funds or reduce amount

**Token Not Found**
- **Error**: "Token not found on [chain]"
- **Cause**: Wrong symbol, chain, or address
- **Fix**: Verify token exists, specify chain, use contract address

**Slippage Exceeded**
- **Error**: "Slippage tolerance exceeded"
- **Cause**: Price moved too much during execution
- **Fix**: Retry, increase slippage, or use smaller amount

**Transaction Reverted**
- **Error**: "Transaction reverted"
- **Cause**: On-chain failure (various reasons)
- **Fix**: Check transaction details, verify parameters

**Network Congestion**
- **Error**: "Network congestion, transaction failed"
- **Cause**: High network activity
- **Fix**: Increase gas, wait, or try L2

### Market/Query Failures

**Market Not Found**
- **Error**: "Polymarket market not found"
- **Cause**: Market closed, wrong search terms
- **Fix**: Try different search, check if market exists

**NFT Not Available**
- **Error**: "NFT listing no longer available"
- **Cause**: NFT was sold to someone else
- **Fix**: Try another listing, check floor price

**Rate Limit**
- **Error**: "Rate limit exceeded"
- **Cause**: Too many requests in short time
- **Fix**: Wait 60 seconds, implement backoff

**Timeout**
- **Error**: "Job timed out"
- **Cause**: Operation took too long
- **Fix**: Simplify query, retry, or check service status

## HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| **400** | Bad request | Check prompt format, validate parameters |
| **401** | Unauthorized | Fix API key (see Authentication section) |
| **402** | Payment required | Ensure wallet has BNKR on Base for fees |
| **403** | Forbidden | Agent API access not enabled — enable at https://bankr.bot/api |
| **429** | Rate limited | Wait and retry with exponential backoff |
| **500** | Server error | Retry after delay |
| **502** | Bad gateway | Temporary issue, retry after delay |
| **503** | Service unavailable | Service maintenance, retry later |

## Network/Connection Errors

### Symptoms
- "Failed to connect"
- "Network error"
- "Timeout"
- "Connection refused"

### Troubleshooting

**Check Internet Connection**
```bash
ping -c 3 api.bankr.bot
```

**Verify API Endpoint**
```bash
curl -I https://api.bankr.bot
```

**Check DNS Resolution**
```bash
nslookup api.bankr.bot
```

**Test with curl**
```bash
curl -sf https://api.bankr.bot || echo "Connection failed"
```

## Balance/Funding Issues

### Insufficient Native Token
**Symptoms**:
- "Insufficient ETH for gas"
- "Not enough MATIC for transaction"
- "Insufficient SOL for fees"

**Fix**:
- Add native token to wallet
- Amounts needed:
  - Ethereum: 0.01-0.05 ETH
  - Base: 0.001-0.01 ETH
  - Polygon: 1-5 MATIC
  - Solana: 0.01-0.1 SOL

### Insufficient Token Balance
**Symptoms**:
- "Insufficient [TOKEN] balance"
- "Balance too low for trade"

**Fix**:
- Check balance first
- Reduce trade amount
- Add more tokens

## Configuration Issues

### Config File Not Found
```bash
# Create config directory
mkdir -p ~/.clawdbot/skills/bankr

# Create config file
cat > ~/.clawdbot/skills/bankr/config.json << 'EOF'
{
  "apiKey": "bk_your_key_here",
  "apiUrl": "https://api.bankr.bot"
}
EOF
```

### Invalid JSON
```bash
# Validate JSON
jq . ~/.clawdbot/skills/bankr/config.json

# If error, fix formatting
```

### Missing jq Command
```bash
# macOS
brew install jq

# Linux (Debian/Ubuntu)
sudo apt install jq

# Linux (RHEL/CentOS)
sudo yum install jq
```

## User-Friendly Error Messages

### Template
```
[What went wrong]

This usually means: [Explanation]

To fix this:
1. [Step 1]
2. [Step 2]
3. [Step 3]

Need help? Visit https://bankr.bot/api
```

### Examples

**Balance Error:**
```
You don't have enough ETH to complete this trade.

This usually means: Your wallet balance is too low for the trade amount plus gas fees.

To fix this:
1. Check your balance: "What is my ETH balance?"
2. Either reduce the trade amount
3. Or add more ETH to your wallet

You currently need at least $XX.XX worth of ETH.
```

**Token Not Found:**
```
Couldn't find the token "XYZ" on Base.

This usually means: The token symbol is wrong, the token doesn't exist on this chain, or it hasn't been indexed yet.

To fix this:
1. Double-check the token symbol spelling
2. Try specifying the chain: "Buy XYZ on Ethereum"
3. Or use the contract address instead

Try: "Search for XYZ token" to find it
```

## Debugging Checklist

Before reporting an issue, check:

- [ ] API key is set and correct
- [ ] Config file exists and has valid JSON
- [ ] Internet connection is working
- [ ] api.bankr.bot is reachable
- [ ] Wallet has sufficient balance (tokens + gas)
- [ ] Token/market exists on specified chain
- [ ] Command syntax is correct
- [ ] No typos in token symbols or addresses
- [ ] Recent similar operations worked

## Getting Help

### Check Status
```bash
# Test API connectivity
~/.clawdbot/skills/bankr/scripts/bankr.sh "ping"

# Check your balance (validates auth)
~/.clawdbot/skills/bankr/scripts/bankr.sh "What is my balance?"
```

### Gather Information
When reporting issues, include:
- Error message (exact text)
- Command that failed
- Job ID (if available)
- Timestamp
- Chain and tokens involved
- Your config (without API key)

### Resources
- **Agent API Reference**: https://www.notion.so/Agent-API-2e18e0f9661f80cb83ccfc046f8872e3
- **API Key Management**: https://bankr.bot/api
- **Twitter**: @bankr_bot
- **Telegram**: @bankr_ai_bot

## Prevention

### Before Operating
1. **Test with small amounts** first
2. **Verify balance** before trades
3. **Check token exists** on chain
4. **Confirm parameters** are correct
5. **Have enough gas** for transactions

### Best Practices
1. Start small and test
2. Keep some native token for gas
3. Verify addresses/symbols
4. Use limit orders for better prices
5. Monitor your automations
6. Review transactions before confirming
7. Keep API key secure

### Regular Maintenance
1. Check balance weekly
2. Review open orders monthly
3. Update automation rules
4. Monitor gas costs
5. Keep config backed up

## Common Mistake Patterns

### Wrong Chain
- **Mistake**: "Buy TOKEN" (doesn't specify chain)
- **Result**: Token not found or wrong chain selected
- **Fix**: "Buy TOKEN on Base"

### Insufficient Gas Buffer
- **Mistake**: Using all ETH in trade
- **Result**: No gas for future transactions
- **Fix**: Keep 0.01 ETH buffer

### Typos in Symbols
- **Mistake**: "ETHE" instead of "ETH"
- **Result**: Token not found
- **Fix**: Double-check spelling

### Forgetting Decimals
- **Mistake**: "Buy 100 ETH" (wants $100 worth)
- **Result**: Tries to buy 100 ETH ($300,000+)
- **Fix**: "Buy $100 of ETH"

### No Stop Loss
- **Mistake**: Opening leverage without stop loss
- **Result**: Risk of liquidation
- **Fix**: Always set stop loss for leverage

## Error Recovery Workflow

```
1. Error occurs
   ↓
2. Read error message carefully
   ↓
3. Check this guide for known issue
   ↓
4. Apply suggested fix
   ↓
5. Test with small amount
   ↓
6. If still failing:
   - Verify config
   - Test API connectivity
   - Report issue with details
```

---

**Remember**: Most errors have simple fixes. Read the error message carefully, check the basics (API key, balance, connection), and consult this guide.
