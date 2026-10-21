import { expect, it } from "vitest";
import { createPrometheusMetricStore } from "./prometheus-metric-store.js";

it("preserves label identity across property order, label shapes, and separator values", () => {
  const store = createPrometheusMetricStore();
  const labels = { a: "one", b: "two|three" };
  store.counter("requests", "Requests.", labels, 2);
  store.counter("requests", "Requests.", { b: "two|three", a: "one" }, 3);
  store.counter("requests", "Requests.", { a: "one|two", b: "three" }, 7);
  store.counter("requests", "Requests.", { a: "one" }, 11);
  store.counter("requests", "Requests.", { b: "one" }, 13);
  store.counter("requests", "Requests.", {}, 17);
  labels.a = "changed";

  const samples = store
    .render()
    .split("\n")
    .filter((line) => line.startsWith("requests"));
  expect(samples).toHaveLength(5);
  expect(samples).toEqual(
    expect.arrayContaining([
      'requests{a="one",b="two|three"} 5',
      'requests{a="one|two",b="three"} 7',
      'requests{a="one"} 11',
      'requests{b="one"} 13',
      "requests 17",
    ]),
  );
});
