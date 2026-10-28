export function formatLlamaServerRuntimeError(error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const library = cause.message.match(/error while loading shared libraries: ([\w.+-]+):/u)?.[1];
  if (!library) {
    return cause;
  }
  const runtime = /^lib(?:ssl|crypto)\.so\.3$/u.test(library)
    ? "OpenSSL 3 (libssl3t64 or libssl3 on Debian/Ubuntu)"
    : library.startsWith("libgomp.so.")
      ? "OpenMP (libgomp1 on Debian/Ubuntu or libgomp on Fedora)"
      : library;
  return new Error(
    `Missing llama-server shared library ${library}. Install the ${runtime} runtime using your system package manager, then rerun llama.cpp setup. Detail: ${cause.message}`,
    { cause },
  );
}
