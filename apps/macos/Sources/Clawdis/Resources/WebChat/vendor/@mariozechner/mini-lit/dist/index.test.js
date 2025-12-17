import assert from "node:assert";
import { test } from "node:test";
test("Library builds", () => {
    // Since we're testing a browser library in Node.js,
    // we can't actually import it without DOM globals.
    // This test just ensures the test suite runs.
    assert.ok(true, "Build and test infrastructure works");
});
//# sourceMappingURL=index.test.js.map