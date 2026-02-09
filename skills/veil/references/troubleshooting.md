# Troubleshooting

## Common Issues

### RPC Rate Limits

**Symptom**: Requests failing, slow responses, or "rate limit exceeded" errors.

**Cause**: Veil queries a lot of blockchain data (UTXOs, merkle proofs, deposit queues). Public RPCs have strict rate limits.

**Solution**: Use a dedicated RPC from [Alchemy](https://www.alchemy.com/), [Infura](https://www.infura.io/), or similar:

```bash
mkdir -p ~/.clawdbot/skills/veil
echo "RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY" > ~/.clawdbot/skills/veil/.env
chmod 600 ~/.clawdbot/skills/veil/.env
```

### VEIL_KEY_MISSING

**Symptom**: Error `VEIL_KEY required`

**Solution**: Run `veil init` to generate a keypair, or ensure your `.env.veil` file exists:

```bash
scripts/veil-init.sh
```

### USER_NOT_REGISTERED

**Symptom**: Transfer fails with "recipient not registered"

**Cause**: The recipient address hasn't registered their deposit key with Veil.

**Solution**: The recipient must run `veil register` before they can receive private transfers.

### NO_UTXOS

**Symptom**: Withdraw/transfer fails with "no UTXOs available"

**Cause**: Your deposits are still in the queue (pending) and haven't been processed into the privacy pool yet.

**Solution**: Wait for the Veil deposit engine to process your deposits. Check status with:

```bash
scripts/veil-balance.sh --address 0xYOUR_ADDRESS
```

Look at the `queue` vs `private` balances in the output.

### INSUFFICIENT_BALANCE

**Symptom**: Transaction fails due to insufficient balance

**Solution**: Check your balances and ensure you have enough in the private pool (not just the queue):

```bash
scripts/veil-balance.sh --address 0xYOUR_ADDRESS
```

### Bankr API Errors

**Symptom**: `apiKey missing` or authentication errors

**Solution**: Ensure Bankr is configured:

```bash
cat ~/.clawdbot/skills/bankr/config.json
# Should contain: {"apiKey": "bk_...", "apiUrl": "https://api.bankr.bot"}
```

### Scripts Not Executable

**Symptom**: `Permission denied` when running scripts

**Solution**:

```bash
chmod +x scripts/*.sh
```

## Debugging Tips

1. **Check balances first** — Most issues stem from funds being in queue vs private pool
2. **Use `--quiet` flag** — Suppresses progress output for cleaner JSON parsing
3. **Check Bankr job status** — If a deposit via Bankr hangs, the job ID is printed for manual status checks
4. **Verify RPC connectivity** — `curl -s YOUR_RPC_URL -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'`

## Getting Help

- Veil SDK: https://github.com/veildotcash/veildotcash-sdk
- Bankr: https://bankr.bot
