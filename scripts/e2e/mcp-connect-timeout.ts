type McpConnectTransport = {
  close?(): Promise<void> | void;
};

export async function connectMcpWithTimeout<TTransport extends McpConnectTransport>(
  client: { connect(transport: TTransport): Promise<void> },
  transport: TTransport,
  timeoutMs: number,
): Promise<void> {
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`MCP stdio connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      Promise.resolve(transport.close?.()).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
