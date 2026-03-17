import os from "node:os";
import path from "node:path";
const msteamsRuntimeStub = {
  state: {
    resolveStateDir: (env = process.env, homedir) => {
      const override = env.OPENCLAW_STATE_DIR?.trim() || env.OPENCLAW_STATE_DIR?.trim();
      if (override) {
        return override;
      }
      const resolvedHome = homedir ? homedir() : os.homedir();
      return path.join(resolvedHome, ".openclaw");
    }
  }
};
export {
  msteamsRuntimeStub
};
