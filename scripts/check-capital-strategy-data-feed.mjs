import assert from "node:assert/strict";
import { DataFeed } from "./strategy-engine/DataFeed.mjs";

const feed = new DataFeed({ barIntervalMs: 1_000 });
const events = [];
const unsubscribe = feed.subscribe("cl", "capital", (event) => events.push(event));

assert.equal(feed.listenerCount("CL", "CAPITAL"), 1);
assert.equal(feed.getPrice("CL", "capital"), null);

const tick1 = feed.pushTick("cl", "capital", 70, {
  volume: 2,
  time: new Date("2026-05-20T00:00:00.000Z"),
});
const tick2 = feed.pushTick("CL", "CAPITAL", 71, {
  volume: 3,
  time: new Date("2026-05-20T00:00:00.500Z"),
});
const tick3 = feed.pushTick("CL", "capital", 72, {
  volume: 4,
  time: new Date("2026-05-20T00:00:01.000Z"),
});

assert.equal(tick1.price, 70);
assert.equal(tick2.price, 71);
assert.equal(tick3.price, 72);
assert.equal(feed.getPrice("CL", "capital"), 72);
assert.deepEqual(feed.snapshot(), { "capital:CL": 72 });
assert.equal(events.length, 4);
assert.equal(events[0].type, "tick");
assert.equal(events[1].type, "tick");
assert.equal(events[2].type, "tick");
assert.deepEqual(events[3], {
  type: "bar",
  instrument: "CL",
  broker: "capital",
  bar: {
    open: 70,
    high: 71,
    low: 70,
    close: 71,
    volume: 5,
    time: "2026-05-20T00:00:00.000Z",
  },
});

const bar = feed.pushBar("mcl", "capital", {
  open: 70,
  high: 71,
  low: 69.5,
  close: 70.5,
  volume: 10,
  time: "2026-05-20T00:01:00.000Z",
});
assert.deepEqual(bar, {
  open: 70,
  high: 71,
  low: 69.5,
  close: 70.5,
  volume: 10,
  time: "2026-05-20T00:01:00.000Z",
});
assert.equal(feed.getPrice("MCL", "capital"), 70.5);

unsubscribe();
assert.equal(feed.listenerCount("CL", "capital"), 0);
feed.pushTick("CL", "capital", 73, { time: new Date("2026-05-20T00:00:02.000Z") });
assert.equal(events.length, 4);

assert.throws(() => feed.subscribe("CL", "capital", null), /callback must be a function/u);

process.stdout.write("capital strategy data feed check PASS\n");
