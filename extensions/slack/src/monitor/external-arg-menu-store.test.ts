// Slack tests cover external arg menu store plugin behavior.
import { describe, expect, it } from "vitest";
import {
  createSlackExternalArgMenuStore,
  SLACK_EXTERNAL_ARG_MENU_PREFIX,
} from "./external-arg-menu-store.js";

describe("createSlackExternalArgMenuStore", () => {
  const choices = [{ label: "Daily", value: "day" }];

  it("returns entries before their expiry", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 1_700_000_000_000);

    expect(store.get(token, 1_700_000_001_000)).toEqual({
      choices,
      userId: "U1",
      expiresAt: 1_700_000_600_000,
    });
  });

  it("drops entries when the current clock is not a valid date timestamp", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 1_700_000_000_000);

    expect(store.get(token, Number.NaN)).toBeUndefined();
    expect(store.get(token, 1_700_000_001_000)).toBeUndefined();
  });

  it("does not retain entries when expiry would exceed the valid date range", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 8_640_000_000_000_000);

    expect(store.get(token, 1_700_000_001_000)).toBeUndefined();
  });

  it("bounds unexpired external menus with least-recently-used eviction", () => {
    const store = createSlackExternalArgMenuStore();
    const now = 1_700_000_000_000;
    const oldestToken = store.create({ choices, userId: "U0" }, now);
    const secondToken = store.create({ choices, userId: "U1" }, now);

    for (let index = 2; index < 256; index += 1) {
      store.create({ choices, userId: `U${index}` }, now);
    }
    expect(store.get(oldestToken, now + 1)).toMatchObject({ userId: "U0" });
    const newestToken = store.create({ choices, userId: "U256" }, now);

    expect(store.get(secondToken, now + 1)).toBeUndefined();
    expect(store.get(oldestToken, now + 1)).toMatchObject({ userId: "U0" });
    expect(store.get(newestToken, now + 1)).toMatchObject({ userId: "U256" });
  });

  it("reads only prefixed valid menu tokens", () => {
    const store = createSlackExternalArgMenuStore();
    const token = store.create({ choices, userId: "U1" }, 1_700_000_000_000);

    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${token}`)).toBe(token);
    expect(store.readToken(token)).toBeUndefined();
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}not a token`)).toBeUndefined();
  });
});
