import { it } from "vitest";

// File/catalog and native-statement contracts do not apply to the experimental engine.
export const sqliteOnly = it.skipIf(Boolean(process.env.OPENCLAW_EXPERIMENTAL_POSTGRES_URL));
