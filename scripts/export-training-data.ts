import * as fs from "fs";
import * as readline from "readline";

const INPUT_FILE = "world-model.jsonl";
const OUTPUT_FILE = "training_dataset.json";

async function main() {
  console.log(`Exporting training data from ${INPUT_FILE}...`);

  if (!fs.existsSync(INPUT_FILE)) {
    console.error("No log file found.");
    return;
  }

  const fileStream = fs.createReadStream(INPUT_FILE);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const dataset = [];

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);

      // We want to format this into an Instruction Tuning format (Alpaca / ChatML)
      // Input: Context/State
      // Output: Action / Prediction

      if (entry.type === "prediction") {
        const { state, actions } = entry;

        // Format:
        // Instruction: Given the following state, predict the next action.
        // Input: <Context>
        // Output: <JSON Actions>

        const prompt = `Given the following context, what should the agent do next?\n\nContext:\n${state.context || ""}`;
        const completion = JSON.stringify(actions);

        dataset.push({
          instruction: prompt,
          input: JSON.stringify(state.messages || []),
          output: completion,
        });
      } else if (entry.type === "simulation") {
        const { state, action, nextState } = entry;
        // Format:
        // Instruction: Simulate the outcome of this action.
        // Input: State + Action
        // Output: Next State Context

        const prompt = `Simulate the consequence of the following action.\n\nContext:\n${state.context}\n\nAction:\n${JSON.stringify(action)}`;
        dataset.push({
          instruction: prompt,
          input: "",
          output: JSON.stringify(nextState),
        });
      }
    } catch {
      // skip bad lines
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(dataset, null, 2));
  console.log(`Exported ${dataset.length} training examples to ${OUTPUT_FILE}`);
}

main().catch(console.error);
