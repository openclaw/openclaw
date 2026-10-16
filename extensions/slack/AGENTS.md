# Slack test ownership

- Use literal expected bytes, IDs, limits, and headers when those values define the contract. Do not derive expectations from the implementation under test.
- Core session recording must settle before reply dispatch. `src/channels/session.test.ts` owns writer-settlement proof. `src/channels/turn/run-channel-turn.pipeline.test.ts` proves the turn awaits its recorder. Slack tests still own normalized sender, channel, thread, and command routing.
- Sent-thread participation uses the persistent V2 cache. Preserve workspace isolation and non-expiring participation. Legacy records retain their expiry and must not prime memory. Non-expiring persisted hits must prime memory.
- Private-download redirects require the real media store and SSRF guard. Fake DNS and terminal fetches, then assert authorization on each hop, redirect-body cancellation, and saved bytes.
- Before retiring an adapter test, transfer its assertions to the named keeper. Verify native CI selection for production changes and deleted test paths. The registered image-tool keeper is `test/slack-download-read-authority.integration.test.ts`.
