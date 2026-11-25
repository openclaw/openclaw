#!/usr/bin/python3
"""Construct a fresh target-native runtime from the canonical installed package."""
from contextlib import ExitStack
import importlib.util
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys

spec = importlib.util.spec_from_file_location(
    "mac_native_inventory", os.path.join(os.path.dirname(__file__), "lib/mac-native-inventory.py")
)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

# PE/COFF machine identifiers (winnt.h), including bigobj/import-object headers;
# XCOFF is big endian. Weak prefix hits must not override file's positive text verdict.
COFF_MAGICS = {value.to_bytes(2, "little") for value in (
    0x14c, 0x166, 0x169, 0x184, 0x1a2, 0x1a3, 0x1a6, 0x1a8,
    0x1c0, 0x1c2, 0x1c4, 0x1d3, 0x1f0, 0x1f1, 0x200, 0x266,
    0x366, 0x466, 0x5032, 0x5064, 0x5128, 0x6232, 0x6264,
    0x8664, 0x9041, 0xa641, 0xa64e, 0xaa64, 0xebc,
)} | {b"\x01\xdf", b"\x01\xf7"}


def candidate(header):
    return (header[:4] in native.MACHO_MAGICS or header[:4] in (b"\x7fELF", b"\0\0\xff\xff")
            or header[:2] == b"MZ" or header[:2] in COFF_MAGICS
            or header[:8] in (b"!<arch>\n", b"!<thin>\n"))


def native_slices(stream, parts):
    stream.seek(0)
    fd_path = f"/dev/fd/{stream.fileno()}"
    info = subprocess.run(
        ["/usr/bin/lipo", "-info", fd_path],
        pass_fds=(stream.fileno(),), stdout=subprocess.PIPE, check=True,
    ).stdout
    # -archs can concatenate fat resource slices; -info separates them.
    # Bind its complete, single-line result to the requested descriptor.
    fd_pattern = re.escape(fd_path.encode())
    match = re.fullmatch(
        rb"(?:Architectures in the fat file: " + fd_pattern +
        rb" are: ([a-zA-Z0-9_]+(?: [a-zA-Z0-9_]+)*) ?|Non-fat file: " +
        fd_pattern + rb" is architecture: ([a-zA-Z0-9_]+))\n", info,
    )
    # lipo can report an unknown CPU with exit 0; it is not an omission verdict.
    if not match or b"unknown" in info:
        raise ValueError(f"Uncertain runtime native slices: {parts!r}")
    return (match[1] or match[2]).split()


def classify(batch, architectures):
    # Inherited /dev/fd names bind tools to the same objects later copied.
    # Darwin dup/dev-fd readers share cursors: rewind before EVERY operation.
    fds = tuple(stream.fileno() for _, stream, _ in batch)
    for _, stream, _ in batch:
        stream.seek(0)
    result = subprocess.run(
        ["/usr/bin/file", "-L", "-E", "-b", "-0", "-0", "--",
         *(f"/dev/fd/{fd}" for fd in fds)],
        pass_fds=fds, stdout=subprocess.PIPE, check=True,
    )
    descriptions = result.stdout.split(b"\0")
    if len(descriptions) != len(batch) + 1 or descriptions[-1] != b"":
        raise ValueError("Incomplete runtime file classification")
    for (entry, stream, header), description in zip(batch, descriptions):
        description = description.split(b"\n", 1)[0]
        if not description or re.search(rb"ERROR|cannot (?:read|open)", description, re.I):
            raise ValueError(f"Invalid runtime file classification: {entry.parts!r}")
        reason = None
        if header[:4] == b"\xca\xfe\xba\xbe" and description.startswith(b"compiled Java class"):
            pass
        elif header[:4] in native.MACHO_MAGICS or header[:8] in (b"!<arch>\n", b"!<thin>\n"):
            if not (description.startswith(b"Mach-O") or description == b"data" or b"ar archive" in description):
                raise ValueError(f"Unclassified runtime native header: {entry.parts!r}")
            slices = native_slices(stream, entry.parts)
            # Optional packages have distinct per-architecture names in the shared tree.
            if not set(arch.encode() for arch in architectures).intersection(slices):
                reason = f"lacks {','.join(architectures)} ({b' '.join(slices).decode()})"
        elif re.search(rb"^(?:ELF|PE32|MS-DOS executable)|\b(?:COFF|XCOFF)\b", description):
            minimum = (64 if header[4:5] == b"\x02" else 52) if header[:4] == b"\x7fELF" else (64 if header[:2] == b"MZ" else 20)
            if len(header) < minimum or re.search(rb"invalid|corrupt|truncated|unknown|missing", description, re.I):
                raise ValueError(f"Malformed runtime native image: {entry.parts!r}")
            reason = f"not Darwin ({description.decode(errors='replace')})"
        # file trims trailing NULs and guesses unknown 8-bit encodings as text.
        # Neither proves that a binary-prefix candidate is an ordinary resource.
        elif b"\0" in header or not re.search(
            rb"(?:^|, )(?:ASCII|Unicode|ISO-8859|(?:International )?EBCDIC) text\b", description
        ):
            raise ValueError(f"Unclassified runtime native header: {entry.parts!r}")
        yield entry, stream, reason


def validate_links(entries, tree):
    """Resolve filesystem-equivalent retained targets, then audit every target edge."""
    children = {parts: set() for parts in entries}
    for parts in entries:
        if parts:
            children[parts[:-1]].add(parts)
    targets = {}
    resolving = set()

    def lookup(parent, name):
        exact = (*parent, name)
        if exact in entries:
            return {exact}
        observed = native.content_identity(tree.lstat_child(parent, name))
        # Existing same-parent hardlinks have identical metadata, but copying
        # splits their output inodes. Retain every equivalent leaf, not one spelling.
        matches = {child for child in children[parent]
                   if native.content_identity(entries[child].info) == observed}
        if not matches:
            raise ValueError(f"Runtime symlink has no retained target: {exact!r}")
        return matches

    def resolve_link(parts):
        if parts in resolving:
            raise ValueError(f"Cyclic runtime symlink: {parts!r}")
        if parts in targets:
            return targets[parts]
        resolving.add(parts)
        target = entries[parts].target
        if os.path.isabs(target):
            raise ValueError(f"Runtime symlink escapes input: {parts!r}")
        resolved = {parts[:-1]}
        for component in target.split("/"):
            following = set()
            for parent in resolved:
                if not isinstance(entries[parent], native.NativeInventoryDirectory):
                    raise ValueError(f"Runtime symlink traverses a non-directory: {parts!r}")
                if component == "..":
                    if not parent:
                        raise ValueError(f"Runtime symlink escapes input: {parts!r}")
                    following.add(parent[:-1])
                elif component in ("", "."):
                    following.add(parent)
                else:
                    for child in lookup(parent, component):
                        following.update(resolve_link(child) if isinstance(
                            entries[child], native.NativeInventorySymlink) else {child})
            resolved = following
        resolving.remove(parts)
        targets[parts] = resolved
        return resolved

    for parts, entry in entries.items():
        if isinstance(entry, native.NativeInventorySymlink):
            resolve_link(parts)
    visiting, visited = set(), set()

    def visit(parts):
        if parts in visiting:
            raise ValueError(f"Cyclic runtime tree: {parts!r}")
        if parts in visited:
            return
        visiting.add(parts)
        for child in targets.get(parts, children[parts]):
            visit(child)
        visiting.remove(parts)
        visited.add(parts)

    visit(())
    return targets


def materialize(source, destination, parent, architectures):
    source = os.path.abspath(source)
    source = os.path.join(os.path.realpath(os.path.dirname(source)), os.path.basename(source))
    parent_path = os.path.abspath(parent)
    parent = os.path.realpath(parent_path)
    destination = os.path.join(os.path.realpath(os.path.dirname(os.path.abspath(destination))),
                               os.path.basename(destination))
    if (not stat.S_ISDIR(os.lstat(parent_path).st_mode)
            or os.path.dirname(destination) != parent
            or os.path.commonpath((source, destination)) in (source, destination)):
        raise ValueError("Runtime output must be disjoint from input and directly inside its staging parent")

    entries, directories, batch = {}, [], []
    retained_files = omitted = 0

    def copy(entry, stream):
        nonlocal retained_files
        stream.seek(0)
        with open(os.path.join(destination, *entry.parts), "xb") as output:
            shutil.copyfileobj(stream, output)
            if output.tell() != entry.info.st_size:
                raise ValueError(f"Short runtime copy: {entry.parts!r}")
            # Darwin writes clear setuid; drain buffered bytes before restoring mode.
            output.flush()
            os.fchmod(output.fileno(), stat.S_IMODE(entry.info.st_mode))
        retained_files += 1

    def flush():
        nonlocal omitted
        for entry, stream, reason in classify(batch, architectures) if batch else ():
            if reason is None:
                copy(entry, stream)
            else:
                del entries[entry.parts]
                omitted += 1
                if omitted <= 40:
                    print(f"Omitting native {json.dumps('/'.join(entry.parts))}: {reason[:240]}", file=sys.stderr)
        handles.close()
        batch.clear()

    # The build owns the private staging parent exclusively until return. Source
    # substitution is untrusted; concurrent writers to output/parent are not supported.
    # mkdir claims only a fresh output; cleanup never removes an existing occupant.
    os.mkdir(destination, 0o700)
    directories.append(destination)
    try:
        with ExitStack() as handles, native.open_native_inventory_tree(source) as tree:
            for entry in tree.entries():
                entries[entry.parts] = entry
                output = os.path.join(destination, *entry.parts)
                if isinstance(entry, native.NativeInventoryDirectory):
                    if entry.parts:
                        os.mkdir(output, 0o700)
                        directories.append(output)
                elif isinstance(entry, native.NativeInventoryFile):
                    header = os.pread(entry.stream.fileno(), 64, 0)
                    if candidate(header):
                        stream = handles.enter_context(os.fdopen(os.dup(entry.stream.fileno()), "rb", buffering=0))
                        batch.append((entry, stream, header))
                        if len(batch) == native.CLASSIFIER_BATCH_SIZE:
                            flush()
                    else:
                        copy(entry, entry.stream)
                elif isinstance(entry, native.NativeInventorySpecial):
                    raise ValueError(f"Unsupported runtime filesystem entry: {entry.parts!r}")
            flush()
            targets = validate_links(entries, tree)
            for entry in entries.values():
                if isinstance(entry, native.NativeInventorySymlink):
                    output = os.path.join(destination, *entry.parts)
                    os.symlink(entry.target, output)
                    os.lchmod(output, stat.S_IMODE(entry.info.st_mode))
            # Source and output volumes may have different name equivalence. Check
            # literal links only after all exist, while output directories are accessible.
            for parts, equivalents in targets.items():
                actual = native.identity(os.stat(os.path.join(destination, *parts)))
                if not any(actual == native.identity(os.lstat(os.path.join(destination, *target)))
                           for target in equivalents):
                    raise ValueError(f"Runtime symlink has no equivalent output target: {parts!r}")
            for entry in reversed(list(entries.values())):
                if isinstance(entry, native.NativeInventoryDirectory):
                    os.chmod(os.path.join(destination, *entry.parts), stat.S_IMODE(entry.info.st_mode))
            tree.validate()
    except BaseException:
        for directory in directories:
            os.chmod(directory, 0o700)
        shutil.rmtree(destination)
        raise
    print(
        f"Materialized {','.join(architectures)} runtime: retained {retained_files} files; "
        f"omitted {omitted} native images "
        "(first 40 native paths logged)",
        file=sys.stderr,
    )


def merge_materialized(source, destination):
    """Combine already materialized sibling trees inside the build's private stage.

    The caller exclusively owns both trees and discards the stage on failure.
    Shared resources must match exactly. Disjoint native slices may be combined
    before codesigning; overlapping CPU slices remain a conflict.
    """
    # Apple's Python keeps a random-device descriptor after tempfile initializes.
    import tempfile

    source, destination = (os.path.abspath(root) for root in (source, destination))
    if (source == destination or os.path.dirname(source) != os.path.dirname(destination)
            or any(not stat.S_ISDIR(os.lstat(root).st_mode) for root in (source, destination))):
        raise ValueError("Runtime merge requires distinct materialized sibling directories")

    def fingerprint(entry):
        content = None
        if isinstance(entry, native.NativeInventoryFile):
            digest = hashlib.sha256()
            for chunk in iter(lambda: entry.stream.read(1024 * 1024), b""):
                digest.update(chunk)
            content = digest.digest()
        elif isinstance(entry, native.NativeInventorySymlink):
            content = entry.target
        elif not isinstance(entry, native.NativeInventoryDirectory):
            raise ValueError(f"Unsupported runtime merge entry: {entry.parts!r}")
        return type(entry), stat.S_IMODE(entry.info.st_mode), content

    with tempfile.TemporaryDirectory(prefix=".runtime-merge-", dir=os.path.dirname(source)) as scratch, \
            native.open_native_inventory_tree(destination) as existing_tree, \
            native.open_native_inventory_tree(source) as source_tree:
        existing, signatures = {}, {}
        for entry in existing_tree.entries():
            existing[entry.parts] = entry
            signatures[entry.parts] = fingerprint(entry)
        validate_links(existing, existing_tree)
        incoming, conflicts, merged = {}, set(), {}
        for entry in source_tree.entries():
            incoming[entry.parts] = entry
            signature = fingerprint(entry)
            if entry.parts in signatures:
                if signature != signatures[entry.parts]:
                    previous = existing[entry.parts]
                    if (signature[:2] != signatures[entry.parts][:2]
                            or not isinstance(entry, native.NativeInventoryFile)
                            or entry.header not in native.MACHO_MAGICS
                            or previous.header not in native.MACHO_MAGICS):
                        raise ValueError(f"Conflicting shared runtime entry: {entry.parts!r}")
                    conflicts.add(entry.parts)
            elif os.path.lexists(os.path.join(destination, *entry.parts)):
                raise ValueError(f"Runtime merge name collision: {entry.parts!r}")
        validate_links(incoming, source_tree)
        existing_tree.validate()
        source_tree.validate()

        if conflicts:
            def selected(tree, expected):
                for entry in tree.entries():
                    if entry.parts in conflicts:
                        if native.content_identity(entry.info) != native.content_identity(expected[entry.parts].info):
                            raise ValueError(f"Runtime merge input changed: {entry.parts!r}")
                        yield entry

            with native.open_native_inventory_tree(destination) as left_tree, \
                    native.open_native_inventory_tree(source) as right_tree:
                right_entries = selected(right_tree, incoming)
                for left in selected(left_tree, existing):
                    right = next(right_entries, None)
                    if right is None or right.parts != left.parts:
                        raise ValueError("Runtime merge native inventory changed")
                    kinds = native.classify_macho_candidates([(entry.stream, str(entry.parts)) for entry in (left, right)])
                    slices = [set(native_slices(entry.stream, entry.parts)) for entry in (left, right)]
                    if (kinds[0] is None or kinds[0] != kinds[1]
                            or any(not value or not value <= {b"arm64", b"x86_64"} for value in slices)
                            or slices[0] & slices[1]):
                        raise ValueError(f"Conflicting shared runtime entry: {left.parts!r} (native slices)")
                    output = os.path.join(scratch, str(len(merged)))
                    fds = tuple(entry.stream.fileno() for entry in (left, right))
                    for entry in (left, right):
                        entry.stream.seek(0)
                    subprocess.run(["/usr/bin/lipo", "-create", *(f"/dev/fd/{fd}" for fd in fds), "-output", output],
                                   pass_fds=fds, stdout=subprocess.PIPE, check=True)
                    with open(output, "rb") as result:
                        if set(native_slices(result, left.parts)) != slices[0] | slices[1]:
                            raise ValueError(f"Incomplete merged runtime slices: {left.parts!r}")
                        if native.classify_macho_candidates([(result, str(left.parts))]) != [kinds[0]]:
                            raise ValueError(f"Invalid merged runtime native image: {left.parts!r}")
                    os.chmod(output, stat.S_IMODE(left.info.st_mode))
                    merged[left.parts] = output
                if next(right_entries, None) is not None or merged.keys() != conflicts:
                    raise ValueError("Runtime merge native inventory changed")
                left_tree.validate()
                right_tree.validate()
            existing_tree.validate()
            source_tree.validate()

        # Preflight finishes before mutation. Reopen through the inventory owner
        # and bind copied bytes to the same admitted source objects.
        added_directories, added_links = [], []
        with native.open_native_inventory_tree(source) as copying_tree:
            for entry in copying_tree.entries():
                previous = incoming.get(entry.parts)
                if previous is None or native.content_identity(entry.info) != native.content_identity(previous.info):
                    raise ValueError(f"Runtime merge source changed: {entry.parts!r}")
                if entry.parts in existing:
                    continue
                output = os.path.join(destination, *entry.parts)
                if isinstance(entry, native.NativeInventoryDirectory):
                    os.mkdir(output, 0o700)
                    added_directories.append(entry)
                elif isinstance(entry, native.NativeInventoryFile):
                    with open(output, "xb") as target:
                        shutil.copyfileobj(entry.stream, target)
                        if target.tell() != entry.info.st_size:
                            raise ValueError(f"Short runtime merge copy: {entry.parts!r}")
                        target.flush()
                        os.fchmod(target.fileno(), stat.S_IMODE(entry.info.st_mode))
                else:
                    added_links.append(entry)
            copying_tree.validate()
        source_tree.validate()
        for parts, output in merged.items():
            os.replace(output, os.path.join(destination, *parts))
        for entry in added_links:
            output = os.path.join(destination, *entry.parts)
            os.symlink(entry.target, output)
            os.lchmod(output, stat.S_IMODE(entry.info.st_mode))
        for entry in reversed(added_directories):
            os.chmod(os.path.join(destination, *entry.parts), stat.S_IMODE(entry.info.st_mode))
    print(f"Merged materialized runtime: added {len(incoming.keys() - existing.keys())} entries", file=sys.stderr)


if __name__ == "__main__":
    try:
        if sys.platform == "darwin" and len(sys.argv) == 4 and sys.argv[1] == "--merge":
            merge_materialized(*sys.argv[2:])
        elif sys.platform != "darwin" or len(sys.argv) != 5 or sys.argv[4] not in ("arm64", "x86_64", "arm64,x86_64", "x86_64,arm64"):
            raise ValueError("Usage: materialize-mac-runtime.py <source> <fresh-output> <staging-parent> <arm64|x86_64|arm64,x86_64> (macOS only)")
        else:
            materialize(*sys.argv[1:4], sys.argv[4].split(","))
    except Exception as error:
        sys.exit(f"[materialize-mac-runtime] FAILED: {error}")
