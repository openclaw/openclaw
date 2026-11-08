#!/usr/bin/env python3
"""
Regression tests for skill packaging security behavior.
"""

import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))


import package_skill as package_skill_module

package_skill = package_skill_module.package_skill


class TestPackageSkillSecurity(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="test_skill_")
        self.addCleanup(directory.cleanup)
        self.temp_dir = Path(directory.name)

    def create_skill(self, name="test-skill"):
        skill_dir = self.temp_dir / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text("---\nname: test-skill\ndescription: test\n---\n")
        (skill_dir / "script.py").write_text("print('ok')\n")
        return skill_dir

    def package_names(self, skill_dir, out_dir):
        result = package_skill(str(skill_dir), str(out_dir))
        self.assertEqual(result, out_dir / f"{skill_dir.name}.skill")
        with zipfile.ZipFile(result) as archive:
            return archive.namelist()

    def test_returns_none_for_non_utf8_skill_md(self):
        skill_dir = self.create_skill("non-utf8-skill")
        (skill_dir / "SKILL.md").write_bytes(
            b"---\nname: non-utf8-skill\ndescription: ok \xff\n---\n"
        )
        out_dir = self.temp_dir / "out"
        self.assertIsNone(package_skill(str(skill_dir), str(out_dir)))
        self.assertFalse((out_dir / "non-utf8-skill.skill").exists())

    def test_packages_regular_entry_and_rejects_linked_entry(self):
        skill_dir = self.create_skill("normal-skill")
        nested = skill_dir / "lib" / "helpers"
        nested.mkdir(parents=True)
        (nested / "util.py").write_text("def run():\n    return 1\n")
        out_dir = self.temp_dir / "out"
        resource = skill_dir / "script.py"
        resource_bytes = resource.read_bytes()
        for timestamp, expected in (
            (0, (1980, 1, 1, 0, 0, 0)),
            (1704067200, time.localtime(1704067200)[:6]),
            (4354905600, (2107, 12, 31, 23, 59, 58)),
        ):
            with self.subTest(timestamp=timestamp):
                os.utime(resource, (timestamp, timestamp))
                result = package_skill(str(skill_dir), str(out_dir))
                self.assertIsNotNone(result)
                skill_file = out_dir / "normal-skill.skill"
                with zipfile.ZipFile(skill_file) as archive:
                    self.assertEqual(set(archive.namelist()), {
                        "normal-skill/SKILL.md", "normal-skill/script.py", "normal-skill/lib/helpers/util.py"
                    })
                    self.assertEqual(archive.read("normal-skill/script.py"), resource_bytes)
                    self.assertEqual(archive.getinfo("normal-skill/script.py").date_time, expected)
                self.assertEqual(resource.read_bytes(), resource_bytes)
                self.assertEqual(resource.stat().st_mtime, timestamp)
        original = skill_file.read_bytes()
        entry = skill_dir / "SKILL.md"
        target = skill_dir / "instructions.md"
        entry.rename(target)
        try:
            entry.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unsupported on this platform")
        for destination in (out_dir, self.temp_dir / "fresh"):
            with self.subTest(destination=destination.name):
                self.assertIsNone(package_skill(str(skill_dir), str(destination)))
                self.assertEqual(skill_file.read_bytes(), original)
                self.assertFalse((self.temp_dir / "fresh" / "normal-skill.skill").exists())

    def test_failed_write_preserves_output_and_cleans_staging(self):
        skill_dir = self.create_skill("failed-skill")
        for existing in (False, True):
            out_dir = self.temp_dir / str(existing)
            out_dir.mkdir()
            archive = out_dir / "failed-skill.skill"
            if existing:
                self.assertIsNotNone(package_skill(str(skill_dir), str(out_dir)))
                original = archive.read_bytes()

            for operation in ("zipfile.ZipFile.write", "os.walk"):
                with self.subTest(existing=existing, operation=operation):
                    with patch(operation, side_effect=OSError("fixture I/O failure")):
                        self.assertIsNone(package_skill(str(skill_dir), str(out_dir)))
                    self.assertEqual(list(out_dir.iterdir()), [archive] if existing else [])
                    if existing:
                        self.assertEqual(archive.read_bytes(), original)

    def test_skips_external_symlinks(self):
        for directory in (False, True):
            with self.subTest(directory=directory):
                name = f"symlink-{directory}-skill"
                skill_dir = self.create_skill(name)
                outside = self.temp_dir / f"outside-{directory}"
                if directory:
                    outside.mkdir()
                (outside / "secret.txt" if directory else outside).write_text("secret\n")
                link = skill_dir / "loot"
                try:
                    link.symlink_to(outside, target_is_directory=directory)
                except (OSError, NotImplementedError):
                    self.skipTest("symlink unsupported on this platform")

                names = self.package_names(skill_dir, self.temp_dir / f"out-{directory}")
                self.assertIn(f"{name}/SKILL.md", names)
                self.assertIn(f"{name}/script.py", names)
                self.assertNotIn(f"{name}/loot" + ("/secret.txt" if directory else ""), names)

    def test_rejects_resolved_path_outside_skill_root(self):
        skill_dir = self.create_skill("escape-skill")
        out_dir = self.temp_dir / "out"
        out_dir.mkdir()

        original_within = package_skill_module._is_within

        def fake_is_within(path_obj: Path, root: Path):
            if path_obj.name == "script.py":
                return False
            return original_within(path_obj, root)

        with patch.object(package_skill_module, "_is_within", fake_is_within):
            result = package_skill(str(skill_dir), str(out_dir))

        self.assertIsNone(result)

    def test_skips_output_archive_when_output_dir_is_skill_dir(self):
        skill_dir = self.create_skill("self-output-skill")

        names = set(self.package_names(skill_dir, skill_dir))
        self.assertEqual(names, {"self-output-skill/SKILL.md", "self-output-skill/script.py"})

    def test_archive_entry_order_is_deterministic(self):
        skill_dir = self.create_skill("order-skill")
        # Files across multiple levels, created in non-sorted order, so the
        # filesystem walk order differs from a lexicographic sort.
        for name, content in (
            ("zeta.md", "z\n"), ("yankee.txt", "y\n"),
            ("alpha/delta.txt", "d\n"), ("alpha/bravo.txt", "b\n"),
            ("zlib/november.txt", "n\n"),
        ):
            path = skill_dir / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        # "alpha-x.txt" discriminates entry-name ordering from Path-object
        # ordering: "-" (0x2d) sorts before "/" (0x2f) in the archive entry
        # name, but Path part-tuple ordering places it after the "alpha/" dir.
        (skill_dir / "alpha-x.txt").write_text("x\n")
        names = self.package_names(skill_dir, self.temp_dir / "out")
        # Entries must be ordered by their archive entry name, regardless of
        # filesystem enumeration or OS path-flavour, so archives are reproducible.
        self.assertEqual(names, sorted(names))
        # Lock the entry-name contract: "alpha-x.txt" precedes "alpha/bravo.txt"
        # (Path-object sorting would invert these).
        self.assertLess(
            names.index("order-skill/alpha-x.txt"),
            names.index("order-skill/alpha/bravo.txt"),
        )
        # Ensure the fixture actually spans multiple directories/files.
        self.assertIn("order-skill/zlib/november.txt", names)


if __name__ == "__main__":
    main()
