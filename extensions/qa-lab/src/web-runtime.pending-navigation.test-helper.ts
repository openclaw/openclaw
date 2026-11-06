export async function withPendingWebPage(params: {
  opening: Promise<unknown>;
  ready: Promise<void>;
  close: () => void | Promise<void>;
  verify: () => Promise<void>;
}) {
  // Observe acquisition immediately; a launch failure cannot reach request readiness.
  const settled = params.opening.catch((error: unknown) => error);
  const failures: unknown[] = [];
  try {
    await Promise.race([
      params.ready,
      params.opening.then(() => {
        throw new Error("web page acquisition completed before pending navigation");
      }),
    ]);
    await params.verify();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await params.close();
    } catch (error) {
      failures.push(error);
    } finally {
      await settled;
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "web page fixture and cleanup failed", {
      cause: failures[0],
    });
  }
}
