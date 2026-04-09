# nix/openclaw.nix
#
# Local openclaw package built from the repo source.
#
# Unlike the nixpkgs openclaw package, this derivation:
# - Builds from the local working tree (not a pinned GitHub tag)
# - Runs `pnpm prune --prod` after build to strip devDependencies
# - Removes non-gateway packages (@node-llama-cpp, @lancedb, typescript)
# - Strips leaked python3 references from koffi codegen scripts
# - Produces a much smaller runtime closure (~1.2 GB vs ~2.3 GB)
#
# The pnpmDeps hash must be updated when pnpm-lock.yaml changes.
# Set it to "" and build to get the correct hash from the error message.
#
{
  pkgs,
  lib,
  src,
  nodejs,
  pnpm,
}:

let
  rolldown = pkgs.rolldown;
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "openclaw";
  version =
    let
      packageJson = builtins.fromJSON (builtins.readFile (src + "/package.json"));
    in
    packageJson.version;

  inherit src;

  pnpmDeps = pkgs.fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 3;
    # Update this hash when pnpm-lock.yaml changes.
    # Set to "" and build — the error message will show the correct hash.
    hash = "sha256-mdppNeJVf0Def0GohiKks6W3uzsaoJUYJo/ggGmypKQ=";
  };

  nativeBuildInputs = [
    pkgs.pnpmConfigHook
    pnpm
    nodejs
    pkgs.makeWrapper
    pkgs.installShellFiles
    pkgs.python3
  ];

  buildInputs = [ rolldown ];

  env.CI = "true";

  buildPhase = ''
    runHook preBuild

    pnpm install --frozen-lockfile

    # Replace pnpm-installed rolldown with the Nix-built version
    rm -rf node_modules/rolldown node_modules/@rolldown/pluginutils
    mkdir -p node_modules/@rolldown node_modules/.pnpm/node_modules/@rolldown
    cp -r ${rolldown}/lib/node_modules/rolldown node_modules/rolldown
    cp -r ${rolldown}/lib/node_modules/@rolldown/pluginutils node_modules/@rolldown/pluginutils
    cp -r ${rolldown}/lib/node_modules/rolldown node_modules/.pnpm/node_modules/rolldown
    cp -r ${rolldown}/lib/node_modules/@rolldown/pluginutils node_modules/.pnpm/node_modules/@rolldown/pluginutils
    chmod -R u+w node_modules/rolldown node_modules/@rolldown/pluginutils \
      node_modules/.pnpm/node_modules/rolldown node_modules/.pnpm/node_modules/@rolldown/pluginutils

    # In Nix sandbox, npm install has no network access. Patch the staging
    # script to:
    # 1. Accept version-mismatched deps from root node_modules
    # 2. Skip (not throw) when deps are completely missing — extensions that
    #    need extra runtime deps will work when installed normally, but the
    #    Nix build can't fetch them.
    substituteInPlace scripts/stage-bundled-plugin-runtime-deps.mjs \
      --replace-fail \
        'if (installedVersion === null || !dependencyVersionSatisfied(spec, installedVersion)) {' \
        'if (false) {' \
      --replace-fail \
        'throw lastError;' \
        'console.warn("Nix build: skipping failed plugin runtime deps staging:", lastError.message); return;'

    pnpm build
    pnpm ui:build

    # Strip devDependencies — this is the key optimization.
    # Reduces node_modules from ~1.9 GB to production-only deps.
    pnpm prune --prod --ignore-scripts

    # Remove large packages not needed for gateway runtime.
    # @node-llama-cpp (664 MB) — prebuilt llama.cpp binaries for local
    #   inference; the gateway delegates inference to external engines.
    # node-llama-cpp (34 MB) — JS wrapper for above.
    # @lancedb (128 MB) — vector DB engine, pulled by extensions; gateway
    #   uses sqlite-vec for its own vector storage.
    # typescript (24 MB) — survives prune as transitive dep of tsdown/tsx;
    #   not needed at runtime since dist/ is pre-bundled.
    rm -rf node_modules/@node-llama-cpp \
           node_modules/node-llama-cpp \
           node_modules/@lancedb \
           node_modules/typescript \
           node_modules/.pnpm/node_modules/@node-llama-cpp \
           node_modules/.pnpm/node_modules/node-llama-cpp \
           node_modules/.pnpm/node_modules/@lancedb \
           node_modules/.pnpm/node_modules/typescript

    # Clean up broken symlinks left behind by pnpm prune
    # https://github.com/pnpm/pnpm/issues/3645
    find node_modules -xtype l -delete

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    libdir=$out/lib/openclaw
    mkdir -p $libdir $out/bin

    cp --reflink=auto -r package.json dist node_modules $libdir/
    cp --reflink=auto -r assets docs skills patches extensions $libdir/

    rm -f $libdir/node_modules/.pnpm/node_modules/clawdbot \
      $libdir/node_modules/.pnpm/node_modules/moltbot \
      $libdir/node_modules/.pnpm/node_modules/openclaw-control-ui

    # Remove broken symlinks created by pnpm workspace linking in extensions
    find $libdir/extensions -xtype l -delete

    makeWrapper ${lib.getExe nodejs} $out/bin/openclaw \
      --add-flags "$libdir/dist/index.js" \
      --set NODE_PATH "$libdir/node_modules"
    ln -s $out/bin/openclaw $out/bin/moltbot
    ln -s $out/bin/openclaw $out/bin/clawdbot

    runHook postInstall
  '';

  postInstall =
    lib.optionalString (pkgs.stdenvNoCC.hostPlatform.emulatorAvailable pkgs.buildPackages)
      (
        let
          emulator = pkgs.stdenvNoCC.hostPlatform.emulator pkgs.buildPackages;
        in
        ''
          # Shell completions are best-effort — the CLI registers all subcommands
          # during completion generation, which can fail if optional runtime files
          # (qa scenarios, etc.) are not bundled. Skip gracefully.
          if ${emulator} $out/bin/openclaw completion --shell bash > /tmp/openclaw.bash 2>/dev/null && [ -s /tmp/openclaw.bash ]; then
            installShellCompletion --cmd openclaw \
              --bash /tmp/openclaw.bash \
              --fish <(${emulator} $out/bin/openclaw completion --shell fish 2>/dev/null || true) \
              --zsh <(${emulator} $out/bin/openclaw completion --shell zsh 2>/dev/null || true)
          else
            echo "Shell completion generation failed (non-fatal) — skipping"
          fi
        ''
      );

  # patchShebangs rewrites .py shebangs in koffi to the Nix store
  # python3, pulling ~180 MB of python into the runtime closure for
  # codegen scripts that are never executed. Strip those references.
  postFixup = ''
    find $out -name '*.py' -exec sed -i '1s|^#!.*/python[0-9.]*|#!/usr/bin/env python3|' {} +
  '';

  meta = {
    description = "Self-hosted, open-source AI assistant/agent";
    homepage = "https://openclaw.ai";
    license = lib.licenses.mit;
    mainProgram = "openclaw";
    platforms = with lib.platforms; linux ++ darwin;
  };
})
