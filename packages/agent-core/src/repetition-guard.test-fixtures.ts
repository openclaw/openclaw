// Captured seeded Ollama runs and the varied-row control from the local-model research corpus.
export const recordedPhraseLoop = " Done, I will output it.".repeat(877) + " Done, I will output";
export const recordedVariedLoopTail = [
  "",
  "Okay, I think that's it.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, the answer is \\boxed{There is no input to check}.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "I think that's the answer.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, I'll go with that.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Okay, done.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, the answer is \\boxed{There is no input to check}.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "I think that's it.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, I'm confident.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Okay, final answer.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, that's it.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "I think that's the answer.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, I'll stop here.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Okay, the answer is \\boxed{There is no input to check}.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, that's it.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "I think that's the final answer.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, I'm done.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Okay, I think that's it.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "Yes, the answer is \\boxed{There is no input to check}.",
  "\\boxed{There is no input to check}",
  "The answer is: \\boxed{There is no input to check}",
  "",
  "I think that's the answer.",
  "\\boxed{There is no input to check}",
  "",
].join("\n");
export const variedRows = Array.from(
  { length: 600 },
  (_, index) => `${index + 1}. Verify service health and report status.`,
).join("\n");

// Distinct records can share most of their markup without being a generation loop.
export const distinctRecordOutputs = [
  {
    name: "HTML table with 150 distinct seven-line rows",
    text: `<table>\n${Array.from({ length: 150 }, (_, index) =>
      [
        "  <tr>",
        `    <td>${index}</td>`,
        `    <td>User ${index}</td>`,
        `    <td>user${index}@example.com</td>`,
        '    <td><span class="badge badge-success">Active</span></td>',
        '    <td><button class="btn btn-primary">View details</button></td>',
        "  </tr>",
      ].join("\n"),
    ).join("\n")}\n</table>`,
  },
  {
    name: "Kubernetes manifest with 100 distinct Services",
    text: Array.from({ length: 100 }, (_, index) =>
      [
        "---",
        "apiVersion: v1",
        "kind: Service",
        "metadata:",
        `  name: application-${index}`,
        "  namespace: production",
        "spec:",
        "  type: ClusterIP",
        "  selector:",
        `    app: application-${index}`,
        "  ports:",
        "    - protocol: TCP",
        "      port: 80",
        "      targetPort: 8080",
      ].join("\n"),
    ).join("\n"),
  },
  {
    name: "pretty JSON with 150 distinct users",
    text: JSON.stringify(
      Array.from({ length: 150 }, (_, index) => ({
        id: index,
        name: `User ${index}`,
        email: `user${index}@example.com`,
        active: true,
        role: "member",
        preferences: { theme: "dark", language: "en" },
      })),
      null,
      2,
    ),
  },
  {
    name: "Jest suite with 90 distinct cases",
    text: Array.from({ length: 90 }, (_, index) =>
      [
        `describe("user ${index}", () => {`,
        '  it("returns the requested user", async () => {',
        `    const response = await request(app).get("/users/${index}");`,
        "    expect(response.status).toBe(200);",
        `    expect(response.body.id).toBe(${index});`,
        "  });",
        "});",
      ].join("\n"),
    ).join("\n"),
  },
  {
    name: "Terraform with 120 distinct buckets",
    text: Array.from({ length: 120 }, (_, index) =>
      [
        `resource "aws_s3_bucket" "bucket_${index}" {`,
        `  bucket = "application-assets-${index}"`,
        "  force_destroy = false",
        "  tags = {",
        '    Environment = "production"',
        `    Name = "application-assets-${index}"`,
        '    ManagedBy = "terraform"',
        "  }",
        "}",
      ].join("\n"),
    ).join("\n"),
  },
  {
    name: "CSV with 600 distinct users",
    text: `id,name,email,status\n${Array.from(
      { length: 600 },
      (_, index) => `${index},User ${index},user${index}@example.com,active`,
    ).join("\n")}`,
  },
];

/** Deterministic irregular mixture mirroring the #182834 runaway reply: many
 * distinct short lines cycle in varying order, so no single line, window, or
 * exact period covers half the tail. */
export function irregularLineMixture(lineCount: number): string {
  const lines = [
    "Let me do it now.",
    "Let me write the response.",
    "Let me write it now.",
    "Let me try again.",
    "I will do it now.",
    "Writing it now.",
    "Let me continue.",
    "Trying again now.",
    "Let me get started.",
    "Working on it now.",
  ];
  // xorshift keeps every line cycling frequently (the field loop repeated each
  // of its 23 lines 200-400 times), while the order stays irregular.
  let state = 42;
  const out: string[] = [];
  for (let index = 0; index < lineCount; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const line = lines[Math.abs(state) % lines.length];
    if (line) {
      out.push(line);
    }
  }
  return out.join("\n");
}
