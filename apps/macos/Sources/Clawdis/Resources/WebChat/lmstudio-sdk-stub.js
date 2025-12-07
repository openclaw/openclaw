// Minimal stub to satisfy @lmstudio/sdk imports in the bundled web chat.
export class LMStudioClient {
  constructor() {
    this.system = {
      async listDownloadedModels() {
        return [];
      },
    };
  }
}

export function connect() {
  throw new Error("LM Studio is not available in the embedded web chat bundle.");
}

export default {
  LMStudioClient,
  connect,
};
