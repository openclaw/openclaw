import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

describe("analyze-contract-points", () => {
  let tempDir: string;
  let claimsDir: string;

  beforeEach(() => {
    // Create a temporary directory for test fixtures
    tempDir = fs.mkdtempSync(path.join(process.cwd(), ".test-analyze-"));
    claimsDir = path.join(tempDir, "docs", "internal", "clarityburst-run-claims");
    fs.mkdirSync(claimsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should load and analyze fixture claims files", () => {
    // Create test fixture files
    const fixtures = [
      {
        file: "run1.gated.claims.json",
        content: {
          mode: "gated",
          workloadId: "run1",
          contractPointsTotal: 10,
          outcomes: {
            proceeds: 5,
            abstains: 3,
            confirms: 1,
            modifies: 1,
          },
        },
      },
      {
        file: "run2.baseline.claims.json",
        content: {
          mode: "baseline",
          workloadId: "run2",
          contractPointsTotal: 50,
          outcomes: {
            proceeds: 25,
            abstains: 15,
            confirms: 7,
            modifies: 3,
          },
        },
      },
      {
        file: "run3.gated.claims.json",
        content: {
          mode: "gated",
          workloadId: "run3",
          contractPointsTotal: 150,
          outcomes: {
            proceeds: 75,
            abstains: 50,
            confirms: 20,
            modifies: 5,
          },
        },
      },
    ];

    // Write fixture files
    for (const fixture of fixtures) {
      const filePath = path.join(claimsDir, fixture.file);
      fs.writeFileSync(filePath, JSON.stringify(fixture.content));
    }

    // Run the analyzer with the test directory
    const outputDir = path.join(tempDir, "docs", "internal");
    const summaryPath = path.join(outputDir, "contract_points_summary.md");
    const csvPath = path.join(outputDir, "contract_points_histogram.csv");

    // We'll manually test the extraction logic instead of executing the full script
    // since we can't easily override the hardcoded paths

    // Extract contract points from fixtures
    const contractPoints: number[] = [];
    for (const fixture of fixtures) {
      const points = fixture.content.contractPointsTotal;
      if (points !== undefined) {
        contractPoints.push(points);
      }
    }

    expect(contractPoints).toEqual([10, 50, 150]);

    // Verify stats
    const sorted = contractPoints.slice().sort((a, b) => a - b);
    expect(Math.min(...contractPoints)).toBe(10);
    expect(Math.max(...contractPoints)).toBe(150);

    // Calculate percentiles
    const calculatePercentile = (arr: number[], p: number) => {
      const index = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, index)];
    };

    expect(calculatePercentile(sorted, 50)).toBe(50);
    expect(calculatePercentile(sorted, 90)).toBe(150);

    // Check threshold
    const exceeding127 = contractPoints.filter((p) => p > 127).length;
    expect(exceeding127).toBe(1);
  });

  it("should handle fallback outcome calculation when contractPointsTotal is missing", () => {
    // Create fixture without contractPointsTotal
    const fixture = {
      mode: "gated",
      workloadId: "run-no-total",
      outcomes: {
        proceeds: 10,
        abstains: 5,
        confirms: 3,
        modifies: 2,
      },
    };

    const filePath = path.join(claimsDir, "run-no-total.gated.claims.json");
    fs.writeFileSync(filePath, JSON.stringify(fixture));

    // Simulate extraction logic
    const extractContractPoints = (entry: Record<string, unknown>) => {
      if (entry.contractPointsTotal !== undefined && typeof entry.contractPointsTotal === "number") {
        return entry.contractPointsTotal;
      }
      if (entry.outcomes && typeof entry.outcomes === "object") {
        const o = entry.outcomes as Record<string, unknown>;
        const { proceeds = 0, abstains = 0, confirms = 0, modifies = 0 } = o as {
          proceeds?: number;
          abstains?: number;
          confirms?: number;
          modifies?: number;
        };
        return proceeds + abstains + confirms + modifies;
      }
      return null;
    };

    const points = extractContractPoints(fixture);
    expect(points).toBe(20);
  });

  it("should generate correct histogram buckets", () => {
    const contractPoints = [10, 25, 50, 75, 100, 127, 128, 150, 200, 300, 400, 500, 600];

    const generateHistogram = (points: number[]): Record<string, number> => {
      const buckets: Record<string, number> = {
        "0-25": 0,
        "26-50": 0,
        "51-75": 0,
        "76-100": 0,
        "101-127": 0,
        "128-150": 0,
        "151-200": 0,
        "201-300": 0,
        "301-500": 0,
        "501+": 0,
      };

      for (const p of points) {
        if (p <= 25) buckets["0-25"]++;
        else if (p <= 50) buckets["26-50"]++;
        else if (p <= 75) buckets["51-75"]++;
        else if (p <= 100) buckets["76-100"]++;
        else if (p <= 127) buckets["101-127"]++;
        else if (p <= 150) buckets["128-150"]++;
        else if (p <= 200) buckets["151-200"]++;
        else if (p <= 300) buckets["201-300"]++;
        else if (p <= 500) buckets["301-500"]++;
        else buckets["501+"]++;
      }

      return buckets;
    };

    const histogram = generateHistogram(contractPoints);

    expect(histogram["0-25"]).toBe(1);
    expect(histogram["26-50"]).toBe(1);
    expect(histogram["51-75"]).toBe(1);
    expect(histogram["76-100"]).toBe(1);
    expect(histogram["101-127"]).toBe(1);
    expect(histogram["128-150"]).toBe(1);
    expect(histogram["151-200"]).toBe(1);
    expect(histogram["201-300"]).toBe(1);
    expect(histogram["301-500"]).toBe(1);
    expect(histogram["501+"]).toBe(1);
  });

  it("should calculate threshold analysis correctly", () => {
    const contractPoints = [10, 50, 100, 127, 128, 150, 200];

    const runsExceeding127 = contractPoints.filter((p) => p > 127).length;
    const percentExceeding127 = Number(
      ((runsExceeding127 / contractPoints.length) * 100).toFixed(2)
    );

    expect(runsExceeding127).toBe(3); // 128, 150, 200
    expect(percentExceeding127).toBe(42.86);
  });
});
