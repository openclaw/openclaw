import { createServer } from "node:net";

export async function assertSignalSetupDaemonBindAvailable(params: {
  httpHost: string;
  httpPort: number;
}): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: params.httpHost, port: params.httpPort, exclusive: true }, resolve);
    });
  } catch (error) {
    throw new Error(
      `Signal cannot start a validation daemon on ${params.httpHost}:${String(params.httpPort)} because that address is already in use. Stop the existing Signal daemon, then retry setup.`,
      { cause: error },
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}
