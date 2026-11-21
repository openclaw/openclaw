import { onTestFinished, vi } from "vitest";

export async function openBaileysLidMapping(authDir: string) {
  const { DEFAULT_CONNECTION_CONFIG, addTransactionCapability, useMultiFileAuthState } =
    await vi.importActual<typeof import("baileys")>("baileys");
  const { state } = await useMultiFileAuthState(authDir);
  const logger = DEFAULT_CONNECTION_CONFIG.logger;
  const keys = addTransactionCapability(
    state.keys,
    logger,
    DEFAULT_CONNECTION_CONFIG.transactionOpts,
  );
  const repository = DEFAULT_CONNECTION_CONFIG.makeSignalRepository({ ...state, keys }, logger);
  onTestFinished(() => repository.close?.());
  return repository.lidMapping;
}
