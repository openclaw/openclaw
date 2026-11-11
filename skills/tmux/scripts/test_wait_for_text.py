import shutil
import subprocess
from pathlib import Path
from unittest import TestCase, skipUnless


@skipUnless(shutil.which("bash") and shutil.which("grep"), "bash and grep are required")
class TestWaitForText(TestCase):
    def test_invalid_regex_reports_error_instead_of_timeout(self):
        script = Path(__file__).with_name("wait-for-text.sh")
        for pattern in ("[", "(", "\\"):
            with self.subTest(pattern=pattern):
                result = subprocess.run(
                    ["bash", str(script), "-t", "unused", "-p", pattern, "-T", "0"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertTrue(result.stderr.strip())
                self.assertNotIn("Timed out", result.stderr)
