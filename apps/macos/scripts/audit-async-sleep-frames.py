#!/usr/bin/env python3
"""Check ARM64 Clock.sleep(for:) async descriptors against reachable frame stores.

Swift can coalesce a specialization's entry point and frame-size descriptor from
different modules. Follow concrete continuations, not duplicate symbol names:
the descriptor must cover every reachable store to its own async frame.
This is a bounded ARM64 codegen check, not a general memory-safety verifier.
Unknown codegen, missing symbols, and unsupported architectures fail closed.
"""

import argparse
import bisect
import hashlib
import json
import mmap
import re
import struct
import subprocess
import sys
import uuid
from pathlib import Path


PREFIX = "_$ss5ClockPsE5sleep3for9tolerance"


class Unsupported(Exception):
    pass


class Binary:
    def __init__(self, path):
        self.path = path
        with path.open("rb") as source:
            self.data = mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ)
        self.base = 0
        self.architectures = []
        self.uuid = None
        magic = self.data[:4]
        if magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
            fat64 = magic[-1] == 0xBF
            count = struct.unpack_from(">I", self.data, 4)[0]
            offsets = []
            for i in range(count):
                pos = 8 + i * (32 if fat64 else 20)
                cpu = struct.unpack_from(">I", self.data, pos)[0]
                self.architectures.append(cpu)
                offset = struct.unpack_from(">Q" if fat64 else ">I", self.data, pos + 8)[0]
                if cpu == 0x100000C:
                    offsets.append(offset)
            if len(offsets) != 1:
                raise Unsupported("expected exactly one ARM64 Mach-O slice")
            self.base = offsets[0]
        header = struct.unpack_from("<8I", self.data, self.base)
        if header[0] != 0xFEEDFACF or header[1] != 0x100000C:
            raise Unsupported("only little-endian ARM64 Mach-O is supported")
        if not self.architectures:
            self.architectures.append(header[1])
        self.segments = []
        self.symbols = {}
        has_local_swift = False
        pos = self.base + 32
        symtab = None
        for _ in range(header[4]):
            command, size = struct.unpack_from("<II", self.data, pos)
            if size < 8:
                raise Unsupported("invalid Mach-O load command")
            if command == 0x19:
                vm, _, offset, length = struct.unpack_from("<4Q", self.data, pos + 24)
                self.segments.append((vm, offset, length))
            elif command == 2:
                symtab = struct.unpack_from("<4I", self.data, pos + 8)
            elif command == 0x1B:
                self.uuid = str(uuid.UUID(bytes=self.data[pos + 8:pos + 24]))
            pos += size
        if not symtab:
            raise Unsupported("Mach-O has no symbol table; audit before stripping")
        offset, count, strings, length = symtab
        for i in range(count):
            index, kind, section, _, address = struct.unpack_from(
                "<IBBHQ", self.data, self.base + offset + i * 16
            )
            if kind & 0xE0 or kind & 0x0E != 0x0E or not section or index >= length:
                continue
            start = self.base + strings + index
            end = self.data.find(b"\0", start, self.base + strings + length)
            if end < 0:
                raise Unsupported("unterminated Mach-O symbol")
            name = self.data[start:end].decode("utf-8")
            has_local_swift |= kind & 1 == 0 and name.startswith("_$s")
            self.symbols.setdefault(address, []).append(name)
        if not has_local_swift:
            raise Unsupported("no local Swift symbols; audit before stripping")
        self.addresses = sorted(self.symbols)
        self.instructions = {}
        self.loaded = set()

    def descriptor(self, address):
        for vm, offset, length in self.segments:
            if vm <= address and address + 8 <= vm + length:
                relative, size = struct.unpack_from("<iI", self.data, self.base + offset + address - vm)
                return address + relative, size
        raise Unsupported(f"descriptor {address:#x} has no file-backed segment")

    def function(self, address, root):
        names = self.symbols.get(address, [])
        matching = [name for name in names if name == root or re.fullmatch(re.escape(root) + r"T[QY]\d+_", name)]
        if len(matching) != 1:
            raise Unsupported(f"continuation {address:#x} is not a known sleep function: {names}")
        name = matching[0]
        if name not in self.loaded:
            result = subprocess.run(
                ["xcrun", "llvm-objdump", "--macho", "--arch=arm64", "--disassemble", "--dis-symname", name, str(self.path)],
                check=True, capture_output=True, text=True,
            )
            for line in result.stdout.splitlines():
                match = re.match(r"^([0-9a-f]+):\s+(?:[0-9a-f]{2}\s+){4}(\w+(?:\.\w+)?)\s*(.*)$", line)
                if match:
                    pc, op, operands = match.groups()
                    self.instructions[int(pc, 16)] = (op, operands)
            self.loaded.add(name)
        next_index = bisect.bisect_right(self.addresses, address)
        if next_index == len(self.addresses):
            raise Unsupported("function has no upper symbol bound")
        return self.addresses[next_index]


def register(value):
    return "x" + value[1:] if re.fullmatch(r"w\d+", value) else value


def immediate(value):
    return int(value.removeprefix("#"), 0)


def shifted(value, amount):
    return (value[0], value[1] + amount) if value else None


def audit(binary, entry, allocation, root):
    # Values are (region, offset): frame, child allocation, stack, or constant.
    # x22 is Swift's async context; a child context's first word is its parent.
    memory = {("frame", 8): ("return", 0)}
    pending = [(entry, entry, {"x22": ("frame", 0), "sp": ("stack", 0)}, memory)]
    visited = set()
    continuations = set()
    stores = {}
    steps = 0

    def enqueue(pc, registers, slots):
        pending.append((pc, pc, registers.copy(), slots.copy()))

    while pending:
        start, pc, regs, slots = pending.pop()
        end = binary.function(start, root)
        continuations.add(start)
        while pc < end:
            state = (pc, tuple(sorted(regs.items())), tuple(sorted(slots.items())))
            if state in visited:
                break
            visited.add(state)
            steps += 1
            if steps > 10000:
                raise Unsupported("sleep control-flow audit exceeded 10,000 states")
            if pc not in binary.instructions:
                raise Unsupported(f"no disassembly at {pc:#x}")
            op, raw = binary.instructions[pc]
            args = raw.split(";", 1)[0].strip()
            parts = [part.strip() for part in args.split(",")]

            def value(operand):
                if operand.startswith("#"):
                    return ("constant", immediate(operand))
                return regs.get(register(operand))

            def assign(dest, result):
                dest = register(dest)
                if result is None:
                    regs.pop(dest, None)
                else:
                    regs[dest] = result

            def branch_address(operand):
                if operand.startswith("0x"):
                    return int(operand.split()[0], 16)
                matches = [address for address, names in binary.symbols.items() if operand in names]
                if len(matches) != 1:
                    raise Unsupported(f"unresolved branch at {pc:#x}: {raw}")
                return matches[0]

            if op in ("str", "strb", "strh", "stur", "sturb", "sturh", "stp", "ldr", "ldrb", "ldrh", "ldur", "ldurb", "ldurh", "ldp"):
                match = re.fullmatch(r"(.+), \[(\w+)(?:, (#[^\]]+))?\](!)?(?:, (#[^ ]+))?", args)
                if not match:
                    raise Unsupported(f"unsupported memory operand at {pc:#x}: {raw}")
                operands, base, displacement, pre, post = match.groups()
                location = shifted(value(base), immediate(displacement) if displacement else 0)
                operands = operands.split(", ")
                width = 1 if op.endswith("b") else 2 if op.endswith("h") else {"x": 8, "w": 4, "d": 8, "s": 4, "q": 16}.get(operands[0][0])
                if width is None:
                    raise Unsupported(f"unsupported memory width at {pc:#x}")
                if pre:
                    assign(base, location)
                for index, operand in enumerate(operands):
                    slot = shifted(location, width * index)
                    if op.startswith("st"):
                        if slot is None:
                            raise Unsupported(f"unresolved store destination at {pc:#x}: {raw}")
                        if slot and slot[0] == "frame":
                            if slot[1] < 0:
                                raise Unsupported(f"negative frame store at {pc:#x}")
                            stores[(pc, slot[1], width)] = op + " " + raw
                        if slot:
                            for known in list(slots):
                                if known[0] == slot[0] and known[1] < slot[1] + width and slot[1] < known[1] + 8:
                                    del slots[known]
                            stored = value(operand) if width == 8 else None
                            if stored is not None:
                                slots[slot] = stored
                    else:
                        assign(operand, slots.get(slot) if width == 8 else None)
                if post:
                    assign(base, shifted(value(base), immediate(post)))
            elif op == "mov":
                assign(parts[0], value(parts[1]))
            elif op in ("adr", "adrp"):
                if op == "adrp":
                    target = re.search(r"; (0x[0-9a-f]+)$", raw)
                    if not target:
                        raise Unsupported(f"missing ADRP target at {pc:#x}")
                    address = int(target[1], 16)
                else:
                    address = immediate(parts[1])
                assign(parts[0], ("constant", address))
            elif op in ("add", "sub"):
                if len(parts) != 3 or not parts[2].startswith("#"):
                    raise Unsupported(f"unsupported pointer arithmetic at {pc:#x}: {raw}")
                amount = immediate(parts[2]) * (1 if op == "add" else -1)
                assign(parts[0], shifted(value(parts[1]), amount))
            elif op in ("and", "orr"):
                if any(value(part) and value(part)[0] == "frame" for part in parts[1:]):
                    raise Unsupported(f"unsupported frame arithmetic at {pc:#x}: {raw}")
                assign(parts[0], None)
            elif op in ("bl", "blr"):
                for index in range(19):
                    regs.pop(f"x{index}", None)
                if "symbol stub for: _swift_task_alloc" in raw:
                    assign("x0", (f"child:{pc:x}", 0))
            elif op in ("cbz", "cbnz", "tbz", "tbnz") or op.startswith("b."):
                target = branch_address(parts[-1])
                # Internal branches keep register state; do not reset x22.
                if not start <= target < end:
                    raise Unsupported(f"conditional branch escapes function at {pc:#x}")
                pending.append((start, target, regs.copy(), slots.copy()))
            elif op in ("b", "br", "ret"):
                if "symbol stub for: _swift_task_switch" in raw:
                    target = value("x0")
                    if not target or target[0] != "constant" or value("x22") != ("frame", 0):
                        raise Unsupported(f"unresolved task switch at {pc:#x}")
                    enqueue(target[1], {"x22": ("frame", 0), "sp": ("stack", 0)}, slots)
                elif op == "br" and value(parts[0]) == ("return", 0):
                    pass
                elif op == "ret":
                    raise Unsupported(f"unexpected synchronous return at {pc:#x}")
                else:
                    context = value("x22")
                    parent = slots.get(context)
                    callback = slots.get(shifted(context, 8))
                    if context and context[0].startswith("child:") and parent == ("frame", 0) and callback and callback[0] == "constant":
                        enqueue(callback[1], {"x22": context, "sp": ("stack", 0)}, slots)
                    else:
                        raise Unsupported(f"unsupported async transfer at {pc:#x}: {raw}")
                break
            else:
                raise Unsupported(f"unsupported instruction at {pc:#x}: {op} {raw}")
            pc += 4
        else:
            raise Unsupported(f"function at {start:#x} fell through its symbol bound")
    if not stores:
        raise Unsupported("specialized sleep has no proven frame stores")
    maximum = max(offset + width for _, offset, width in stores)
    return {
        "symbol": root, "entry": hex(entry), "allocation_bytes": allocation,
        "required_bytes": maximum, "in_bounds": maximum <= allocation,
        "continuations": [hex(address) for address in sorted(continuations)],
        "largest_stores": [
            {"address": hex(pc), "offset": offset, "width": width, "instruction": instruction}
            for (pc, offset, width), instruction in sorted(stores.items()) if offset + width == maximum
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path, help="unstripped Mach-O app executable; checks ARM64 only")
    args = parser.parse_args()
    report = {"executable": str(args.executable), "architecture": "arm64", "frames": []}
    try:
        binary = Binary(args.executable)
        report.update(
            uuid=binary.uuid,
            sha256=hashlib.sha256(binary.data).hexdigest(),
            slices=[{0x100000C: "arm64", 0x1000007: "x86_64"}.get(cpu, hex(cpu)) for cpu in binary.architectures],
        )
        descriptors = [(address, name) for address, names in binary.symbols.items() for name in names if name.startswith(PREFIX) and name.endswith("Tu")]
        if not descriptors and any(name.startswith(PREFIX) for names in binary.symbols.values() for name in names):
            raise Unsupported("sleep functions exist without descriptors; audit before stripping")
        for address, name in descriptors:
            entry, size = binary.descriptor(address)
            frame = audit(binary, entry, size, name[:-2])
            frame["descriptor"] = hex(address)
            report["frames"].append(frame)
        report["result"] = "pass" if all(frame["in_bounds"] for frame in report["frames"]) else "fail"
        report["scope"] = "local Clock.sleep(for:) descriptors and their reachable ARM64 frame stores; other architectures are not audited"
        print(json.dumps(report, indent=2))
        return 0 if report["result"] == "pass" else 1
    except (Unsupported, OSError, ValueError, struct.error, subprocess.CalledProcessError) as error:
        report.update(result="unsupported", error=str(error))
        print(json.dumps(report, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
