# LM Studio Test Ownership

- Keep configured catalog projection checks at the registered provider boundary
  and discovered metadata checks at the fetch boundary. Retain direct public
  helper tests when those boundaries hide a contract, such as `undefined` versus
  empty compatibility metadata.
- Memory-core owns fallback selection and removal of the primary endpoint and
  credentials. The memory adapter passes `fallback: "none"` to the private
  factory; do not test fallback activation by bypassing that adapter contract.
- Keep serialized preload context checks in the instance-routing fixture.
  Retain separate stream tests for cancellation, concurrent preload ownership,
  backoff and plugin wrapper composition.
- Preserve the public callback-based setup API and its non-wizard coverage.
