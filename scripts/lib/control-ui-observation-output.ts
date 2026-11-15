import { appendFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createControlUiObservationWriter(directory: string) {
  return {
    async record(observation: { artifactPrefix: string }): Promise<void> {
      await writeFile(
        path.join(directory, `${observation.artifactPrefix}.json`),
        JSON.stringify(observation, null, 2),
      );
      await appendFile(
        path.join(directory, "observations.jsonl"),
        `${JSON.stringify(observation)}\n`,
      );
    },
    async finish(observations: readonly unknown[]): Promise<void> {
      const destination = path.join(directory, "observations.json");
      const temporary = path.join(directory, ".observations.json.tmp");
      await writeFile(temporary, JSON.stringify(observations, null, 2));
      await rename(temporary, destination);
    },
  };
}
