export async function releaseQaCredentialLease(
  lease: { release(): Promise<void> },
  heartbeat: { stop(): Promise<void> },
) {
  try {
    await heartbeat.stop();
  } finally {
    await lease.release();
  }
}
