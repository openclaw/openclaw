# Ollama

## Test Ownership

- Discovery success assertions require discovered models and a ready outcome.
  Check credential forwarding separately from the persisted local auth marker.
- `provider-models.preflight-timeout.test.ts` owns real-guard DNS deadlines,
  including caller overrides. Node deadline tests own the total HTTP workflow.
- `setup.cancellation.test.ts` owns wizard-to-discovery cancellation. Keep the
  default context-enrichment path separate from the wizard's tool inspection.
- Assert recursive tool schema normalization at the outgoing stream request.
  Keep helper cases only for distinct root or nested-object contracts.
- Hold async payload preparation open to test service acquisition ordering.
  Observe readiness at acquisition entry; the mock must not enforce the order.
- Match the complete content-free stream diagnostic, not just its prefix.
  `stream-ndjson.test.ts` owns record framing and size bounds; reader-cancellation
  lifecycle cases stay with the guarded stream tests.
- Exercise canceled metadata caching through `ollama.models` without a timeout
  that independently bypasses the cache. Keep the key stable and prove both
  cancellation isolation and subsequent successful reuse.
- Vary credentials and non-secret tenant headers independently in cache tests.
- For cancellation between search fallbacks, let the first response finish and
  keep the next response valid. Assert that no additional request starts.
- Use independent literal expectations for endpoint and auth-marker defaults,
  not the constants used by the harness under test.
