import { resolveAutoThink } from "../src/auto-reply/reply/auto-reasoning.js";

const prompts = [
  { label: "Prompt 1", text: "what is 4+4" },
  { label: "Prompt 2", text: "explain quantum wave function in detail" },
  {
    label: "Prompt 3",
    text: "design a migration strategy for distributed DB failover across regions",
  },
];

for (const prompt of prompts) {
  const effective = resolveAutoThink({ messageBody: prompt.text });
  const statusBarLabel = `think auto→${effective}`;
  const sessionStatusLabel = `Think: auto→${effective}`;
  console.log(`${prompt.label}: ${prompt.text}`);
  console.log(`  status bar:   ${statusBarLabel}`);
  console.log(`  session_status: ${sessionStatusLabel}`);
  console.log(
    `  match: ${statusBarLabel.endsWith(`→${effective}`) && sessionStatusLabel.endsWith(`→${effective}`)}`,
  );
}
