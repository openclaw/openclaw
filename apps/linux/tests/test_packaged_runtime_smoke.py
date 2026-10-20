import hashlib
import json
from pathlib import Path
import re
import tempfile
import textwrap
import unittest
from unittest import mock

import packaged_runtime_smoke as smoke


def version_output(*, needs=(), definitions=()):
    lines = [
        "Version symbols section '.gnu.version' contains 1 entry:",
        "  000:   0 (*local*)",
        "Version needs section '.gnu.version_r' contains 1 entry:",
        " Addr: 0x0  Offset: 0x0  Link: 0 (.dynstr)",
        "  000000: Version: 1  File: libc.so.6  Cnt: 1",
    ]
    lines.extend(
        f"  0x0010:   Name: {name}  Flags: none  Version: 2"
        for name in needs
    )
    lines.extend(
        [
            "Version definition section '.gnu.version_d' contains 1 entry:",
            " Addr: 0x0  Offset: 0x0  Link: 0 (.dynstr)",
        ]
    )
    lines.extend(
        f"  0x001c: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: {name}"
        for name in definitions
    )
    return "\n".join(lines) + "\n"


class PackagedRuntimeAbiTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.appdir = self.root / "squashfs-root"
        self.appdir.mkdir()
        self.readelf = self.root / "readelf"
        self.readelf.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                from pathlib import Path
                import sys

                target = Path(sys.argv[-1])
                if Path(f"{target}.readelf-error").exists():
                    print(f"readelf: Error: {target}: synthetic failure")
                    raise SystemExit(1)
                suffix = "header" if "--file-header" in sys.argv else "versions"
                print(Path(f"{target}.readelf-{suffix}").read_text(), end="")
                """
            )
        )
        self.readelf.chmod(0o755)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write_elf(
        self,
        path,
        output,
        *,
        machine="Advanced Micro Devices X86-64",
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\x7fELFsynthetic")
        Path(f"{path}.readelf-header").write_text(
            f"ELF Header:\n  Machine:                           {machine}\n"
        )
        Path(f"{path}.readelf-versions").write_text(output)
        return path

    def collect(
        self,
        appimage_output,
        appdir_outputs=(),
        *,
        machine="Advanced Micro Devices X86-64",
        host_machine="x86_64",
    ):
        appimage = self.write_elf(
            self.root / "OpenClaw.AppImage",
            appimage_output,
            machine=machine,
        )
        for relative, output in appdir_outputs:
            self.write_elf(self.appdir / relative, output, machine=machine)
        with mock.patch.object(smoke.platform, "machine", return_value=host_machine):
            return smoke.collect_abi_report(
                appimage,
                self.appdir,
                readelf=str(self.readelf),
                # Generic ABI fixtures model historical packages without Bun.
                allow_legacy_runtime=True,
            )

    def test_missing_bundled_runtime_requires_explicit_historical_opt_in(self):
        appimage = self.write_elf(self.root / "OpenClaw.AppImage", version_output())
        with mock.patch.object(smoke.platform, "machine", return_value="x86_64"):
            with self.assertRaisesRegex(RuntimeError, "Missing required bundled runtime"):
                smoke.collect_abi_report(appimage, self.appdir, readelf=str(self.readelf))
            report = smoke.collect_abi_report(
                appimage, self.appdir, readelf=str(self.readelf), allow_legacy_runtime=True
            )
        self.assertEqual([entry["path"] for entry in report["files"]], [appimage.name])

    def test_historical_opt_in_still_rejects_an_incomplete_bundled_runtime(self):
        (self.appdir / smoke.BUNDLED_BUN_PATH).parent.mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, "invalid runtime manifest"):
            self.collect(version_output())

    def test_exact_limits_pass(self):
        report = self.collect(
            version_output(
                needs=(
                    "GLIBC_2.35",
                    "GLIBCXX_3.4.30",
                    "CXXABI_1.3.13",
                    "GCC_12.0.0",
                )
            ),
        )

        smoke.enforce_abi_limits(report)

        self.assertEqual(report["architecture"], "x86_64")
        self.assertEqual(
            report["maximumRequired"],
            {
                "GLIBC": "2.35",
                "GLIBCXX": "3.4.30",
                "CXXABI": "1.3.13",
                "GCC": "12.0.0",
            },
        )

    def test_versions_above_limits_are_rejected_numerically(self):
        for required in (
            "GLIBC_2.36",
            "GLIBCXX_3.4.31",
            "CXXABI_1.3.14",
            "GCC_13.0.0",
        ):
            with self.subTest(required=required):
                report = self.collect(version_output(needs=(required,)))
                with self.assertRaisesRegex(
                    RuntimeError,
                    rf"{required} .*limit ",
                ):
                    smoke.enforce_abi_limits(report)

    def test_x86_64_cxxabi_variants_pass_and_are_reported(self):
        report = self.collect(
            version_output(
                needs=(
                    "CXXABI_TM_1",
                    "CXXABI_FLOAT128",
                    "CXXABI_1.3.13",
                )
            ),
        )

        smoke.enforce_abi_limits(report)

        self.assertEqual(
            report["files"][0]["requires"]["CXXABI"],
            ["1.3.13", "FLOAT128", "TM_1"],
        )
        self.assertEqual(report["maximumRequired"]["CXXABI"], "1.3.13")

    def test_x86_64_cxxabi_variants_fail_closed_on_aarch64(self):
        for required in ("CXXABI_TM_1", "CXXABI_FLOAT128"):
            with self.subTest(required=required):
                with self.assertRaisesRegex(
                    RuntimeError,
                    rf"unknown CXXABI version {required}",
                ):
                    self.collect(
                        version_output(needs=(required,)),
                        machine="AArch64",
                        host_machine="aarch64",
                    )

    def test_host_architecture_aliases_match_outer_elf_header(self):
        for machine, host_machine, expected in (
            ("Advanced Micro Devices X86-64", "x86_64", "x86_64"),
            ("Advanced Micro Devices X86-64", "amd64", "x86_64"),
            ("AArch64", "aarch64", "aarch64"),
            ("AArch64", "arm64", "aarch64"),
        ):
            with self.subTest(machine=machine, host_machine=host_machine):
                report = self.collect(
                    version_output(),
                    machine=machine,
                    host_machine=host_machine,
                )
                self.assertEqual(report["architecture"], expected)

    def test_outer_elf_architecture_must_match_native_host(self):
        with self.assertRaisesRegex(
            RuntimeError,
            "AppImage architecture mismatch: artifact is aarch64, host is x86_64",
        ):
            self.collect(
                version_output(),
                machine="AArch64",
                host_machine="amd64",
            )

    def test_unknown_outer_elf_machine_fails_closed(self):
        with self.assertRaisesRegex(
            RuntimeError,
            "appimage-runtime uses unsupported ELF machine RISC-V",
        ):
            self.collect(
                version_output(),
                machine="RISC-V",
            )

    def test_unknown_host_architecture_fails_closed(self):
        with self.assertRaisesRegex(
            RuntimeError,
            "unsupported host architecture ppc64le",
        ):
            self.collect(
                version_output(),
                host_machine="ppc64le",
            )

    def test_version_definitions_do_not_affect_requirements(self):
        requirements = smoke.parse_version_needs(
            version_output(
                needs=("GLIBC_2.35",),
                definitions=(
                    "GLIBC_9.99",
                    "GLIBCXX_99.0.0",
                    "CXXABI_99.0.0",
                    "GCC_99.0.0",
                ),
            ),
            "usr/bin/openclaw-desktop",
            "x86_64",
        )

        self.assertEqual(
            requirements,
            {
                "GLIBC": ["2.35"],
                "GLIBCXX": [],
                "CXXABI": [],
                "GCC": [],
            },
        )

    def test_report_includes_outer_runtime_and_sorts_relative_paths(self):
        appimage = self.write_elf(
            self.root / "OpenClaw.AppImage",
            version_output(needs=("GLIBC_2.34",)),
        )
        self.write_elf(
            self.appdir / "usr/lib/z.so",
            version_output(needs=("GLIBCXX_3.4.29",)),
        )
        self.write_elf(
            self.appdir / "usr/bin/a",
            version_output(needs=("GLIBC_2.17",)),
        )
        (self.appdir / "usr/bin/not-elf").write_text("plain text")
        (self.appdir / "usr/lib/z-link.so").symlink_to("z.so")
        with mock.patch.object(smoke.platform, "machine", return_value="x86_64"):
            report = smoke.collect_abi_report(
                appimage, self.appdir, readelf=str(self.readelf), allow_legacy_runtime=True
            )

        self.assertEqual(
            [(entry["path"], entry["source"]) for entry in report["files"]],
            [
                ("OpenClaw.AppImage", "appimage-runtime"),
                ("usr/bin/a", "appdir"),
                ("usr/lib/z.so", "appdir"),
            ],
        )
        self.assertNotIn(str(self.root), json.dumps(report))

    def test_report_output_is_deterministic_and_written_before_rejection(self):
        report = self.collect(
            version_output(needs=("GLIBC_2.36",)),
            (
                (
                    "usr/lib/libexample.so",
                    version_output(needs=("GLIBC_2.17", "GLIBC_2.35")),
                ),
            ),
        )
        first = self.root / "first"
        second = self.root / "second"
        first.mkdir()
        second.mkdir()

        smoke.write_abi_report(first, report)
        smoke.write_abi_report(second, report)
        with self.assertRaisesRegex(RuntimeError, "AppImage ABI floor exceeded"):
            smoke.enforce_abi_limits(report)

        self.assertEqual(
            (first / "abi.json").read_bytes(),
            (second / "abi.json").read_bytes(),
        )

    def test_unknown_abi_variants_fail_closed(self):
        for family, required in (
            ("GLIBC", "GLIBC_ABI_DT_RELR"),
            ("GLIBCXX", "GLIBCXX_DEBUG_MESSAGE_LENGTH"),
            ("CXXABI", "CXXABI_FUTURE"),
            ("CXXABI", "CXXABI_IEEE128_1.3.13"),
            ("GCC", "GCC_PRIVATE"),
        ):
            with self.subTest(required=required):
                with self.assertRaisesRegex(
                    RuntimeError,
                    rf"unknown {family} version {required}",
                ):
                    smoke.parse_version_needs(
                        version_output(needs=(required,)),
                        "usr/lib/libc.so.6",
                        "x86_64",
                    )

    def test_readelf_errors_fail_closed(self):
        appimage = self.write_elf(
            self.root / "OpenClaw.AppImage",
            version_output(),
        )
        Path(f"{appimage}.readelf-error").touch()

        with self.assertRaisesRegex(
            RuntimeError,
            "readelf failed for appimage-runtime with exit 1",
        ):
            with mock.patch.object(smoke.platform, "machine", return_value="x86_64"):
                smoke.collect_abi_report(
                    appimage,
                    self.appdir,
                    readelf=str(self.readelf),
                )

    def write_bundled_bun(self, executable=b"\x7fELFsynthetic bun"):
        resource = self.appdir / smoke.BUNDLED_BUN_PATH
        resource.parent.mkdir(parents=True, exist_ok=True)
        resource.write_bytes(b"OPENCLAW-BUN-RUNTIME-V1\n" + executable)
        (resource.parent.parent / "manifest.json").write_text(json.dumps({
            "platform": "linux",
            "files": {"bin/bun": hashlib.sha256(executable).hexdigest()},
        }))
        return resource

    def test_enveloped_bun_abi_is_checked_and_reported_at_its_bundle_path(self):
        resource = self.write_bundled_bun()
        source_path = smoke.BUNDLED_BUN_PATH.as_posix()
        readelf = smoke.run_readelf

        def inspect(path, source, tool, *arguments):
            if source != source_path:
                return readelf(path, source, tool, *arguments)
            self.assertNotEqual(path, resource)
            self.assertEqual(path.read_bytes(), b"\x7fELFsynthetic bun")
            if arguments == ("--file-header",):
                return "ELF Header:\n  Machine: Advanced Micro Devices X86-64\n"
            return version_output(needs=("GLIBC_2.36", "GLIBCXX_3.4.30"))

        with mock.patch.object(smoke, "run_readelf", side_effect=inspect):
            report = self.collect(version_output(needs=("GLIBC_2.17",)))
        self.assertEqual(report["files"][-1], {
            "path": source_path,
            "source": "appdir",
            "requires": {"GLIBC": ["2.36"], "GLIBCXX": ["3.4.30"], "CXXABI": [], "GCC": []},
        })
        self.assertNotIn("openclaw-bun-abi-", json.dumps(report))
        with self.assertRaisesRegex(RuntimeError, re.escape(source_path) + r" requires GLIBC_2.36"):
            smoke.enforce_abi_limits(report)

    def test_enveloped_bun_refuses_damaged_prefix_and_decoded_hash(self):
        resource = self.write_bundled_bun()
        for payload, error in (
            (b"BROKEN\n\x7fELFsynthetic bun", "invalid runtime envelope"),
            (b"OPENCLAW-BUN-RUNTIME-V1\n\x7fELFtampered bun", "runtime checksum mismatch"),
        ):
            with self.subTest(error=error):
                resource.write_bytes(payload)
                with self.assertRaisesRegex(RuntimeError, error):
                    self.collect(version_output())

    def test_enveloped_bun_rejects_a_different_architecture(self):
        self.write_bundled_bun()
        readelf = smoke.run_readelf

        def inspect(path, source, tool, *arguments):
            if source == smoke.BUNDLED_BUN_PATH.as_posix():
                return "ELF Header:\n  Machine: AArch64\n"
            return readelf(path, source, tool, *arguments)

        with mock.patch.object(smoke, "run_readelf", side_effect=inspect):
            with self.assertRaisesRegex(RuntimeError, "architecture does not match"):
                self.collect(version_output())


class PackagedRuntimeGStreamerTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.appdir = self.root / "squashfs-root"
        hook = self.appdir / "apprun-hooks/linuxdeploy-plugin-gstreamer.sh"
        hook.parent.mkdir(parents=True)
        hook.write_text("# packaged GStreamer environment\n")
        self.output = self.root / "output"
        self.output.mkdir()
        self.log = self.root / "tools.log"
        self.host_tools = self.root / "host tools"
        self.host_tools.mkdir()
        self.matching_tools = self.root / "matching tools"
        self.matching_tools.mkdir()
        self.write_tool(
            self.host_tools / "gst-inspect-1.0",
            'printf "host-inspect:%s\\n" "$1" >> "$PROBE_LOG"\n',
        )
        self.write_tool(
            self.host_tools / "gst-launch-1.0",
            'printf "host-launch\\n" >> "$PROBE_LOG"\nexit 42\n',
        )
        self.write_tool(
            self.host_tools / "timeout",
            'shift\nexec "$@"\n',
        )
        self.write_tool(
            self.matching_tools / "gst-inspect-1.0",
            'printf "matching-inspect:%s\\n" "$1" >> "$PROBE_LOG"\n',
        )
        self.write_tool(
            self.matching_tools / "gst-launch-1.0",
            'printf "matching-launch\\n" >> "$PROBE_LOG"\n',
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write_tool(self, path, body):
        path.write_text(f"#!/bin/sh\nset -eu\n{body}")
        path.chmod(0o755)

    def test_explicit_gstreamer_tools_override_incompatible_path(self):
        sample = self.root / "sample.wav"
        sample.touch()
        env = {
            "PATH": str(self.host_tools),
            "PROBE_LOG": str(self.log),
        }
        gst_inspect, gst_launch = smoke.resolve_gstreamer_tools(
            self.matching_tools,
            search_path=str(self.host_tools),
        )

        smoke.bundled_gstreamer_probe(
            self.appdir,
            self.output,
            env,
            [sample],
            gst_inspect=gst_inspect,
            gst_launch=gst_launch,
        )

        lines = self.log.read_text().splitlines()
        self.assertEqual(
            [line.removeprefix("matching-inspect:") for line in lines[:-1]],
            list(smoke.REQUIRED_GSTREAMER_ELEMENTS),
        )
        self.assertEqual(lines[-1], "matching-launch")
        self.assertFalse(any(line.startswith("host-") for line in lines))

    def test_gstreamer_tools_dir_requires_both_executables(self):
        cases = (
            ("gst-inspect-1.0", "missing"),
            ("gst-inspect-1.0", "not executable"),
            ("gst-launch-1.0", "missing"),
            ("gst-launch-1.0", "not executable"),
        )
        for name, condition in cases:
            with self.subTest(name=name, condition=condition):
                tools = self.root / f"{name}-{condition}"
                tools.mkdir()
                for candidate in smoke.GSTREAMER_TOOL_NAMES:
                    if candidate == name and condition == "missing":
                        continue
                    path = tools / candidate
                    self.write_tool(path, "exit 0\n")
                    if candidate == name:
                        path.chmod(0o644)

                with self.assertRaisesRegex(
                    RuntimeError,
                    rf"GStreamer tool {re.escape(name)} is {condition}: ",
                ):
                    smoke.resolve_gstreamer_tools(tools)


if __name__ == "__main__":
    unittest.main()
