# Install & Recovery

> **Prerequisite:** Read the [main skill](../SKILL.md) for authentication, global flags, and key concepts.

This reference covers CLI installation, authentication failure recovery, and version compatibility checks. These steps are only needed when a `dune` command fails.

---

## CLI Not Found Recovery

If the command fails because `dune` is not found on PATH (e.g. "command not found"), install it. **Always try Option A (automated) first.** Only fall back to Option B if Option A fails.

### Option A -- Automated install (no user interaction)

The default installer writes to `/usr/local/bin`, which requires `sudo` and fails in non-interactive terminals. Instead, install to a user-writable directory.

**Choosing the install directory:**

Before running any commands, read the `PATH` environment variable yourself (do NOT run PATH-scanning scripts in the user's terminal). Look for an existing directory under the user's home that is already on PATH. Common ones:

- `$HOME/.local/bin`, `$HOME/bin`, `$HOME/go/bin`, `$HOME/.cargo/bin`
- On Windows: directories under `%USERPROFILE%` (e.g. `AppData\Local\Microsoft\WindowsApps`, scoop shims)

Pick the first one that exists on PATH. If none is found, fall back to `$HOME/.local/bin` (or `%USERPROFILE%\.local\bin` on Windows).

**macOS / Linux -- run each step as a separate command:**

1. Only if the chosen directory doesn't exist yet (i.e. using the fallback):

   ```bash
   mkdir -p "$HOME/.local/bin"
   ```

2. Download the installer:

   ```bash
   curl -sSfL -o /tmp/dune_install.sh https://github.com/duneanalytics/cli/raw/main/install.sh
   ```

3. Run the installer into the chosen directory (`INSTALL_DIR` must be on the same line -- it is **not** picked up when piping curl to bash):

   ```bash
   INSTALL_DIR="<chosen-dir>" bash /tmp/dune_install.sh
   ```

4. Add to PATH for the current session:

   ```bash
   export PATH="<chosen-dir>:$PATH"
   ```

5. Only if the fallback was used, persist to shell profile (skip if `<chosen-dir>` was already on PATH):

   ```bash
   grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
   ```

   (Use `~/.bashrc` instead if the user's shell is bash.)

6. Verify:
   ```bash
   dune --help
   ```

**Windows (PowerShell) -- run each step as a separate command:**

1. Only if the chosen directory doesn't exist yet (i.e. using the fallback):

   ```powershell
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.local\bin"
   ```

2. Run the installer:

   ```powershell
   $env:INSTALL_DIR = "<chosen-dir>"; irm https://github.com/duneanalytics/cli/raw/main/install.ps1 | iex
   ```

3. Add to PATH for the current session:

   ```powershell
   $env:Path = "<chosen-dir>;$env:Path"
   ```

4. Only if the fallback was used, persist to user PATH:

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", "<chosen-dir>;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
   ```

5. Verify:
   ```powershell
   dune --help
   ```

### Option B -- User-assisted install (fallback)

If Option A fails, ask the user to run the install command themselves in a separate terminal. They can provide `sudo` if needed:

**macOS / Linux:**

```bash
curl -sSfL https://github.com/duneanalytics/cli/raw/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://github.com/duneanalytics/cli/raw/main/install.ps1 | iex
```

> **Security note:** Option B pipes a remote script directly into the shell. This is convenient but means the script is executed without inspection. Option A (downloading first, then running) is safer. If the user has concerns, recommend they download and inspect the script before running it.

Tell the user to come back once the install is complete, then re-check with `command -v dune` (or `Get-Command dune` on Windows).

---

## Authentication Failure Recovery

If a command fails with an authentication or authorization error (e.g. 401, "unauthorized", "missing API key"), the user needs to authenticate. **Stop and ask the user** to authenticate in a separate terminal:

1. Go to Dune (https://dune.com), navigate to the "APIs & Connectors" section, and then the "API Keys" tab to generate an API key (if they don't have one)
2. Run `dune auth` in their terminal and follow the prompts
3. Come back to the conversation once done

Then retry the original command. If it still fails, inform the user their key appears invalid and ask them to retry.

Do **not** attempt to handle the API key yourself -- the user must authenticate outside of this session.

---

## Version Compatibility

This skill is written for the Dune CLI version specified by `cli_version` in the frontmatter above. Patch versions don't matter -- only major and minor.

**Do NOT check the version proactively.** Only run `dune --version` when a command fails and the error looks like a skill/CLI incompatibility, for example:

- Unknown subcommand or flag (e.g. "unknown command", "unknown flag")
- Unexpected output format (e.g. JSON fields the skill references are missing)
- A command documented in this skill doesn't exist

When you see such an error, run `dune --version`, parse the major.minor, and compare to `cli_version`:

- **Major version mismatch**: **Stop.** Tell the user the CLI version is incompatible and they must upgrade (or downgrade). Point them to re-run the install steps from Option A above.
- **Minor version mismatch**: **Warn** the user that versions differ and recommend upgrading the CLI or the skill. Continue attempting the task -- minor differences are usually non-breaking.
- **Versions match**: Not a version problem. Debug the error normally.

---

## See Also

- [Main skill](../SKILL.md) -- Command overview and key concepts
