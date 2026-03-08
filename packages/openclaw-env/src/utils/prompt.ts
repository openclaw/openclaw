import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

type SelectOption<T extends string> = {
  label: string;
  value: T;
};

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function promptText(params: {
  message: string;
  defaultValue?: string;
}): Promise<string> {
  const suffix = params.defaultValue ? ` (${params.defaultValue})` : "";
  const answer = await ask(`${params.message}${suffix}: `);
  if (!answer && params.defaultValue !== undefined) {
    return params.defaultValue;
  }
  return answer;
}

export async function promptConfirm(params: {
  message: string;
  defaultValue?: boolean;
}): Promise<boolean> {
  const defaultValue = params.defaultValue ?? false;
  const hint = defaultValue ? "[Y/n]" : "[y/N]";

  while (true) {
    const answer = (await ask(`${params.message} ${hint}: `)).toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    output.write("Please enter y or n.\n");
  }
}

export async function promptSelect<T extends string>(params: {
  message: string;
  options: Array<SelectOption<T>>;
  defaultValue?: T;
}): Promise<T> {
  output.write(`${params.message}\n`);
  for (let i = 0; i < params.options.length; i += 1) {
    const option = params.options[i];
    output.write(`  ${i + 1}) ${option.label}\n`);
  }

  const defaultIndex = Math.max(
    0,
    params.defaultValue ? params.options.findIndex((o) => o.value === params.defaultValue) : 0,
  );

  while (true) {
    const answer = await ask(`Select [1-${params.options.length}] (default ${defaultIndex + 1}): `);
    if (!answer) {
      return params.options[defaultIndex].value;
    }
    const parsed = Number.parseInt(answer, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= params.options.length) {
      return params.options[parsed - 1].value;
    }
    output.write("Please enter a valid number.\n");
  }
}
