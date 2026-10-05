/** CLI token that stops root option scanning and leaves following args positional. */
export const FLAG_TERMINATOR = "--";

const ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);

/** Returns whether a token can be consumed as a root option value. */
export function isValueToken(arg) {
  if (!arg || arg === FLAG_TERMINATOR) {
    return false;
  }
  if (!arg.startsWith("-")) {
    return true;
  }
  return /^-\d+(?:\.\d+)?$/.test(arg);
}

/** Count root-option tokens conservatively for route matching. */
export function consumeRootOptionToken(args, index) {
  const arg = args[index];
  if (!arg) {
    return 0;
  }
  if (ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  if (
    arg.startsWith("--profile=") ||
    arg.startsWith("--log-level=") ||
    arg.startsWith("--container=")
  ) {
    return 1;
  }
  if (ROOT_VALUE_FLAGS.has(arg)) {
    return isValueToken(args[index + 1]) ? 2 : 1;
  }
  return 0;
}

/** Consume required root values by their Commander role before startup policy is selected. */
export function consumeRootCommandOptionToken(args, index) {
  return consumeKnownOptionToken(args, index, ROOT_BOOLEAN_FLAGS, ROOT_VALUE_FLAGS, "command-path");
}

/** Read positional command tokens while accepting root options at any pre-terminator position. */
export function getRootOptionAwareCommandPath(argv, depth) {
  const args = argv.slice(2);
  const path = [];
  let literal = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      break;
    }
    if (!literal && arg === FLAG_TERMINATOR) {
      // A leading terminator still leaves a command to discover; later operands belong to callers.
      if (path.length > 0) {
        break;
      }
      literal = true;
      continue;
    }
    const consumed = literal ? 0 : consumeRootCommandOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      continue;
    }
    path.push(arg);
    if (path.length >= depth) {
      break;
    }
  }
  return path;
}

function consumeKnownOptionToken(args, index, booleanFlags, valueFlags, mode) {
  const arg = args[index];
  if (!arg || arg === FLAG_TERMINATOR || !arg.startsWith("-")) {
    return 0;
  }

  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (booleanFlags.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!valueFlags.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return mode === "command-path" || arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  // Required Commander values include empty strings, flag-looking tokens, and `--`.
  // Discovery must consume them before choosing startup policy; routes still validate values.
  if (mode === "command-path") {
    return args[index + 1] !== undefined ? 2 : 0;
  }
  return isValueToken(args[index + 1]) ? 2 : 0;
}

/** Parse command positionals while consuming known root and command options. */
export function getCommandPositionalsWithRootOptions(argv, options) {
  return parseCommandArgsWithRootOptions(argv, options, false);
}

/** Preserve the leaf's raw arguments after consuming its root and parent options. */
export function getCommandArgsWithRootOptions(argv, options) {
  return parseCommandArgsWithRootOptions(argv, options, true);
}

/** Keep option roles intact when another command must use the same root selectors. */
export function getCommandOptionsWithRootOptions(argv, options) {
  return parseCommandArgsWithRootOptions(argv, options, false, true);
}

function parseCommandArgsWithRootOptions(argv, options, returnTail, returnOptions = false) {
  const args = argv.slice(2);
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals = [];
  const rootOptions = [];
  const commandOptions = [];
  let commandIndex = 0;
  let literal = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      break;
    }
    if (!literal && arg === FLAG_TERMINATOR) {
      if (options.mode !== "command-path") {
        break;
      }
      literal = true;
      continue;
    }
    const rootConsumed = literal
      ? 0
      : options.mode === "command-path"
        ? consumeRootCommandOptionToken(args, index)
        : consumeRootOptionToken(args, index);
    if (rootConsumed > 0) {
      // Gateway's post-command --dev bootstraps its workspace, not a root profile.
      const destination = commandIndex > 0 && booleanFlags.has(arg) ? commandOptions : rootOptions;
      destination.push(...args.slice(index, index + rootConsumed));
      index += rootConsumed - 1;
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      const optionConsumed = consumeKnownOptionToken(
        args,
        index,
        booleanFlags,
        valueFlags,
        options.mode,
      );
      if (optionConsumed === 0 || commandIndex === 0) {
        return null;
      }
      commandOptions.push(arg);
      index += optionConsumed - 1;
      continue;
    }
    if (commandIndex < options.commandPath.length) {
      if (arg !== options.commandPath[commandIndex]) {
        return null;
      }
      commandIndex += 1;
      if (returnTail && commandIndex === options.commandPath.length) {
        const tail = args.slice(index + 1);
        // A downstream parser must not reactivate flags after an earlier literal boundary.
        return literal ? [FLAG_TERMINATOR, ...tail] : tail;
      }
      continue;
    }
    positionals.push(arg);
    if (!returnOptions && positionals.length === options.maxPositionals) {
      return positionals;
    }
  }

  return commandIndex < options.commandPath.length
    ? null
    : returnOptions
      ? { rootOptions, commandOptions }
      : positionals;
}

export function rewriteUpdateFlagArgv(argv) {
  // Preserve the old root --update spelling by rewriting before Commander registration.
  // Only rewrite --update while scanning the root-option prefix; once a command
  // or `--` appears, later --update tokens belong to that command's arguments.
  const updateIndex = argv.indexOf("--update");
  if (updateIndex === -1) {
    return argv;
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      return argv;
    }
    if (i === updateIndex) {
      return argv.toSpliced(updateIndex, 1, "update");
    }
    const consumed = consumeRootOptionToken(argv, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return argv;
    }
  }
  return argv;
}

// Update option roles must be identical in the installed launcher and Commander.
export const UPDATE_OPTION_SPECS = [
  ["--json", "Output result as JSON", false],
  ["--no-restart", "Skip restarting the gateway service after a successful update"],
  ["--dry-run", "Preview update actions without making changes", false],
  [
    "--admission <auto|installed>",
    "Select candidate or installed admission checks (default: auto)",
  ],
  ["--channel <stable|extended-stable|beta|dev>", "Persist update channel (git + npm)"],
  [
    "--tag <dist-tag|version|spec>",
    "Override the package target for this update (dist-tag, version, or package spec)",
  ],
  ["--timeout <seconds>", "Set a per-step deadline in seconds"],
  ["--drain-timeout <seconds>", "Set the immutable activation drain budget before interruption"],
  ["--sha <commit>", "Prepare an exact official commit for an adopted immutable installation"],
  ["--yes", "Skip confirmation prompts (non-interactive)", false],
  [
    "--reapply-local-overrides",
    "Replay trusted packaged dist edits when the target baseline is unchanged",
    false,
  ],
  ["--accept-capabilities", "Accept widened plugin capabilities", false],
];

/** Resolve update children without mistaking parent option values for commands. */
export function getUpdateCommandPath(argv) {
  const [command] = getRootOptionAwareCommandPath(argv, 1);
  if (command !== "update") {
    return null;
  }
  const booleanFlags = UPDATE_OPTION_SPECS.filter(([flags]) => !flags.includes("<")).map(
    ([flags]) => flags,
  );
  const valueFlags = UPDATE_OPTION_SPECS.filter(([flags]) => flags.includes("<")).map(([flags]) =>
    flags.slice(0, flags.indexOf(" ")),
  );
  const child = getCommandPositionalsWithRootOptions(argv, {
    commandPath: [command],
    booleanFlags,
    valueFlags,
    maxPositionals: 1,
    mode: "command-path",
  })?.[0];
  return child ? [command, child] : [command];
}
