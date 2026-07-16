const ANSI_OSC_INTRODUCER_PATTERN = "(?:\\x1b\\]|\\x9d)";
const ANSI_STRING_TERMINATOR_PATTERN = "(?:\\x1b\\\\|\\x07|\\x9c)";
const ANSI_OSC_SEQUENCE_PATTERN = `${ANSI_OSC_INTRODUCER_PATTERN}[\\s\\S]*?${ANSI_STRING_TERMINATOR_PATTERN}`;
const ANSI_CONTROL_SEQUENCE_PATTERN =
  "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX = new RegExp(
  `${ANSI_OSC_SEQUENCE_PATTERN}|${ANSI_CONTROL_SEQUENCE_PATTERN}`,
  "y",
);

export class AnsiSequenceStripper {
  private pendingControl: CompatControlState | null = null;
  private pendingEsc = false;
  private inOsc = false;
  private oscSawEsc = false;

  write(input: string): string {
    if (typeof input !== "string") {
      throw new TypeError(`Expected a \`string\`, got \`${typeof input}\``);
    }
    if (
      !this.inOsc &&
      !this.pendingControl &&
      !this.pendingEsc &&
      !input.includes("\u001B") &&
      !input.includes("\u009B") &&
      !input.includes("\u009D")
    ) {
      return input;
    }
    const output: string[] = [];
    let index = 0;

    if (this.inOsc) {
      index = this.consumeOsc(input, 0);
    }

    if (this.pendingEsc) {
      this.pendingEsc = false;
      if (index >= input.length) {
        return "";
      }
      if (input.charCodeAt(index) === 0x5d) {
        index = this.consumeOsc(input, index + 1);
      } else {
        const result = consumeCompatControl(input, index, createCompatControlState());
        this.pendingControl = result.pendingState;
        index = result.index;
        if (this.pendingControl) {
          return "";
        }
        if (!result.completed) {
          output.push(input.charAt(index));
          index += 1;
        }
      }
    }

    if (this.pendingControl) {
      const pendingControl = this.pendingControl;
      const result = consumeCompatControl(input, index, pendingControl);
      this.pendingControl = result.pendingState;
      index = result.index;
      if (this.pendingControl) {
        return "";
      }
      if (!result.completed) {
        output.push(input.charAt(index));
        index += 1;
      }
    }

    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code === 0x1b && index + 1 >= input.length) {
        this.pendingEsc = true;
        index += 1;
        continue;
      }
      if (isOscIntroducer(input, index)) {
        index = this.consumeOsc(input, index + (code === 0x9d ? 1 : 2));
        continue;
      }

      if (isCompatControlIntroducer(input, index)) {
        const result = consumeCompatControl(input, index + 1, createCompatControlState());
        if (result.pendingState) {
          this.pendingControl = result.pendingState;
          index = result.index;
          continue;
        }
      }

      ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX.lastIndex = index;
      const match = ANSI_COMPAT_SEQUENCE_AT_INDEX_REGEX.exec(input);
      if (match) {
        index += match[0].length;
        continue;
      }

      if (isCompatControlIntroducer(input, index)) {
        const result = consumeCompatControl(input, index + 1, createCompatControlState());
        this.pendingControl = result.pendingState;
        index = result.index;
        if (this.pendingControl || result.completed) {
          continue;
        }
      }

      output.push(input.charAt(index));
      index += 1;
    }

    return output.join("");
  }

  finish(): string {
    this.pendingControl = null;
    this.pendingEsc = false;
    this.inOsc = false;
    this.oscSawEsc = false;
    return "";
  }

  private consumeOsc(input: string, start: number): number {
    this.inOsc = true;
    for (let index = start; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (this.oscSawEsc) {
        this.oscSawEsc = false;
        if (code === 0x5c) {
          this.inOsc = false;
          return index + 1;
        }
      }
      if (code === 0x07 || code === 0x9c) {
        this.inOsc = false;
        return index + 1;
      }
      if (code === 0x1b) {
        this.oscSawEsc = true;
      }
    }
    return input.length;
  }
}

type CompatControlState = {
  phase: "prefix" | "parameter";
  parameterDigits: number;
};

function isOscIntroducer(input: string, index: number): boolean {
  const code = input.charCodeAt(index);
  return code === 0x9d || (code === 0x1b && input.charCodeAt(index + 1) === 0x5d);
}

function isCompatControlIntroducer(input: string, index: number): boolean {
  const code = input.charCodeAt(index);
  return code === 0x9b || (code === 0x1b && input.charCodeAt(index + 1) !== 0x5d);
}

function createCompatControlState(): CompatControlState {
  return { phase: "prefix", parameterDigits: 0 };
}

function consumeCompatControl(
  input: string,
  start: number,
  initialState: CompatControlState,
): { completed: boolean; index: number; pendingState: CompatControlState | null } {
  let state = { ...initialState };
  let index = start;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (state.phase === "prefix" && isCompatPrefixCode(code)) {
      index += 1;
      continue;
    }
    if (isCompatFinalCode(code)) {
      return { completed: true, index: index + 1, pendingState: null };
    }
    if (isCompatParameterCode(code)) {
      if (state.phase !== "parameter") {
        state = { phase: "parameter", parameterDigits: 0 };
      }
      state = nextCompatParameterState(state, code);
      if (state.parameterDigits > 4) {
        return { completed: false, index, pendingState: null };
      }
      index += 1;
      continue;
    }
    return { completed: false, index, pendingState: null };
  }
  return { completed: false, index, pendingState: state };
}

function isCompatPrefixCode(code: number): boolean {
  return (
    code === 0x5b ||
    code === 0x5d ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x23 ||
    code === 0x3b ||
    code === 0x3f
  );
}

function isCompatParameterCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || code === 0x3a || code === 0x3b;
}

function nextCompatParameterState(state: CompatControlState, code: number): CompatControlState {
  if (code === 0x3a || code === 0x3b) {
    return { ...state, parameterDigits: 0 };
  }
  return { ...state, parameterDigits: state.parameterDigits + 1 };
}

function isCompatFinalCode(code: number): boolean {
  return (
    (code >= 0x40 && code <= 0x5a) ||
    code === 0x63 ||
    (code >= 0x66 && code <= 0x6e) ||
    (code >= 0x71 && code <= 0x75) ||
    code === 0x79 ||
    code === 0x3d ||
    code === 0x3e ||
    code === 0x3c ||
    code === 0x7e
  );
}
