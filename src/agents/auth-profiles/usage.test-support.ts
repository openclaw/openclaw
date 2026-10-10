import "./usage.js";

type AuthProfileUsageTestApi = {
  resetWhamReprobeStateForTest(): void;
};

function getTestApi(): AuthProfileUsageTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.authProfileUsageTestApi")
  ] as AuthProfileUsageTestApi;
}

export const testing: AuthProfileUsageTestApi = {
  resetWhamReprobeStateForTest: () => getTestApi().resetWhamReprobeStateForTest(),
};
