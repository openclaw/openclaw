// Writes a CLI plugin fixture for release scenario E2E tests.
import { writeCliPlugin } from "../fixtures/plugins.mjs";

writeCliPlugin(process.argv.slice(2));
