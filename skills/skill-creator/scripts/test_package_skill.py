#!/usr/bin/env python3
"""
Regression tests for skill packaging security behavior.
"""

import sys
import tempfile
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

    def test_packages_regular_entry_and_rejects_linked_entry(self):
        skill_dir = self.create_skill("normal-skill")
        nested = skill_dir / "lib" / "helpers"
        nested.mkdir(parents=True)
        (nested / "util.py").write_text("def run():\n    return 1\n")
        out_dir = self.temp_dir / "out"
        result = package_skill(str(skill_dir), str(out_dir))
        self.assertIsNotNone(result)
        skill_file = out_dir / "normal-skill.skill"
        self.assertTrue(skill_file.exists())
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = set(archive.namelist())
        self.assertIn("normal-skill/SKILL.md", names)
        self.assertIn("normal-skill/script.py", names)
        self.assertIn("normal-skill/lib/helpers/util.py", names)
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
            with self.subTest(existing=existing):
                out_dir = self.temp_dir / str(existing)
                out_dir.mkdir()
                archive = out_dir / "failed-skill.skill"
                if existing:
                    self.assertIsNotNone(package_skill(str(skill_dir), str(out_dir)))
                    original = archive.read_bytes()

                with patch.object(zipfile.ZipFile, "write", side_effect=OSError("disk full")):
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
                out_dir = self.temp_dir / f"out-{directory}"
                out_dir.mkdir()
                try:
                    link.symlink_to(outside, target_is_directory=directory)
                except (OSError, NotImplementedError):
                    self.skipTest("symlink unsupported on this platform")

                self.assertIsNotNone(package_skill(str(skill_dir), str(out_dir)))
                skill_file = out_dir / f"{name}.skill"
                self.assertTrue(skill_file.exists())
                with zipfile.ZipFile(skill_file, "r") as archive:
                    names = set(archive.namelist())
                self.assertIn(f"{name}/SKILL.md", names)
                self.assertIn(f"{name}/script.py", names)
                self.assertNotIn(f"{name}/loot" + ("/secret.txt" if directory else ""), names)

    def test_unreadable_directory_does_not_publish_incomplete_archive(self):
        skill_dir = self.create_skill()
        assets = skill_dir / "assets"
        assets.mkdir()
        (assets / "template.txt").write_text("required template\n")
        out_dir = self.temp_dir / "out"
        archive = package_skill(skill_dir, out_dir)
        self.assertIsNotNone(archive)
        original = archive.read_bytes()

        assets.chmod(0)
        try:
            try:
                list(assets.iterdir())
            except PermissionError:
                pass
            else:
                self.skipTest("directory permissions are not enforced for this user/platform")

            for destination in (out_dir, self.temp_dir / "fresh"):
                with self.subTest(destination=destination.name):
                    self.assertIsNone(package_skill(skill_dir, destination))
                    self.assertEqual(archive.read_bytes(), original)
                    self.assertFalse((self.temp_dir / "fresh" / "test-skill.skill").exists())
        finally:
            assets.chmod(0o700)

        self.assertIsNotNone(package_skill(skill_dir, out_dir))
        with zipfile.ZipFile(archive) as packaged:
            self.assertIn("test-skill/assets/template.txt", packaged.namelist())

    def test_unreadable_excluded_directory_is_skipped(self):
        skill_dir = self.create_skill()
        excluded = skill_dir / "node_modules"
        excluded.mkdir()
        (excluded / "dependency.js").write_text("excluded\n")
        excluded.chmod(0)
        try:
            archive = package_skill(skill_dir, self.temp_dir / "out")
            self.assertIsNotNone(archive)
            with zipfile.ZipFile(archive) as packaged:
                self.assertEqual(
                    set(packaged.namelist()), {"test-skill/SKILL.md", "test-skill/script.py"}
                )
        finally:
            excluded.chmod(0o700)

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

        result = package_skill(str(skill_dir), str(skill_dir))

        self.assertIsNotNone(result)
        skill_file = skill_dir / "self-output-skill.skill"
        self.assertTrue(skill_file.exists())
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = set(archive.namelist())
        self.assertEqual(names, {"self-output-skill/SKILL.md", "self-output-skill/script.py"})

    def test_archive_entry_order_is_deterministic(self):
        skill_dir = self.create_skill("order-skill")
        # Files across multiple levels, created in non-sorted order, so the
        # filesystem/rglob enumeration order differs from a lexicographic sort.
        (skill_dir / "zeta.md").write_text("z\n")
        (skill_dir / "yankee.txt").write_text("y\n")
        alpha = skill_dir / "alpha"
        alpha.mkdir()
        (alpha / "delta.txt").write_text("d\n")
        (alpha / "bravo.txt").write_text("b\n")
        nested = skill_dir / "zlib"
        nested.mkdir()
        (nested / "november.txt").write_text("n\n")
        # "alpha-x.txt" discriminates entry-name ordering from Path-object
        # ordering: "-" (0x2d) sorts before "/" (0x2f) in the archive entry
        # name, but Path part-tuple ordering places it after the "alpha/" dir.
        (skill_dir / "alpha-x.txt").write_text("x\n")
        out_dir = self.temp_dir / "out"
        out_dir.mkdir()

        result = package_skill(str(skill_dir), str(out_dir))

        self.assertIsNotNone(result)
        skill_file = out_dir / "order-skill.skill"
        with zipfile.ZipFile(skill_file, "r") as archive:
            names = [name for name in archive.namelist() if not name.endswith("/")]
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
