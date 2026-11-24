"""Health-body boundary fixtures; no Gateway, CLI, or state database is opened."""

import contextlib
import importlib.machinery
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit


BODY = Path(__file__).with_name("openclaw-health-check")


class HealthCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        loader = importlib.machinery.SourceFileLoader("health_check", str(BODY))
        cls.code = compile(loader.get_source("health_check"), str(BODY), "exec")

    def setUp(self):
        self.release = Path("/opt/openclaw-team/releases") / ("a" * 40)
        self.snapshot = (
            "ActiveState=active\nSubState=running\n"
            "ExecStart={ argv[]=/usr/bin/node /opt/openclaw-team/current/dist/index.js gateway --port 18888 ; }\n"
            'Environment=OPENCLAW_GATEWAY_PORT=19999 "UNRELATED=value with spaces"\n'
        )
        self.http = []
        self.transport_error = None
        self.commands = []
        self.gateway = {"/healthz": {"ok": True}, "/readyz": {"ready": True}}
        self.values = ["299.5", "0", "0", "1073741824"]
        self.replies = [
            {"status": "success", "data": {"resultType": "vector", "result": [
                {"metric": {"job": "openclaw", "instance": "127.0.0.1:9464"},
                 "value": [2000, value]}
            ]}} for value in self.values
        ]

    def run_body(self):
        output, errors = io.StringIO(), io.StringIO()
        requests = iter(self.replies)

        def command(argv, **_kwargs):
            self.commands.append(argv)
            if argv[:3] != ["/usr/bin/systemctl", "show", "openclaw-gateway.service"]:
                raise AssertionError(f"unexpected subprocess (CLI bootstrap forbidden): {argv}")
            return subprocess.CompletedProcess(argv, 0, stdout=self.snapshot)

        def request(url, **_kwargs):
            self.http.append(url)
            if self.transport_error is not None:
                raise self.transport_error
            parsed = urlsplit(url)
            self.assertEqual(parsed.hostname, "127.0.0.1")
            if parsed.path == "/api/v1/query":
                self.assertEqual(parsed.port, 19090)
                self.assertIn("query", parse_qs(parsed.query))
                payload = next(requests)
            else:
                payload = self.gateway[parsed.path]
            return io.BytesIO(payload if isinstance(payload, bytes) else json.dumps(payload).encode())

        def read_text(path, *_args, **_kwargs):
            if path != Path("/proc/self/cgroup"):
                raise AssertionError(f"unexpected file read: {path}")
            return "0::/system.slice/openclaw-hourly-health-check.service\n"

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch("sys.argv", [str(BODY), str(self.release / "openclaw.mjs")]))
            stack.enter_context(patch.dict(os.environ, {"OPENCLAW_MAINTENANCE_VERIFIED_AT_MS": "1000000"}))
            stack.enter_context(patch("os.geteuid", return_value=1000))
            stack.enter_context(patch("time.time", return_value=2000))
            stack.enter_context(patch.object(Path, "read_text", read_text))
            stack.enter_context(patch("builtins.open", side_effect=AssertionError("unexpected file open")))
            stack.enter_context(patch.object(Path, "open", side_effect=AssertionError("unexpected Path.open")))
            stack.enter_context(patch("subprocess.run", side_effect=command))
            stack.enter_context(patch("subprocess.Popen", side_effect=AssertionError("unexpected process spawn")))
            stack.enter_context(patch("urllib.request.OpenerDirector.open", side_effect=request))
            stack.enter_context(contextlib.redirect_stdout(output))
            stack.enter_context(contextlib.redirect_stderr(errors))
            with self.assertRaises(SystemExit) as exited:
                exec(self.code, {"__name__": "__main__", "__file__": str(BODY)})
        return exited.exception.code, output.getvalue(), errors.getvalue()

    def test_healthy_idle_gateway_reports_acceptance_age_without_cli_or_state_reads(self):
        code, output, errors = self.run_body()
        self.assertEqual((code, errors), (0, ""))
        self.assertEqual(json.loads(output), {
            "ok": True, "release": "a" * 40, "accepted_age_seconds": 1000,
            "event_loop_seconds_5m": 299.5, "sessions_running": 0,
            "sessions_queued": 0, "heap_used_bytes": 1073741824,
        })
        self.assertEqual(len(self.commands), 1)
        self.assertEqual([urlsplit(url).port for url in self.http[:2]], [18888, 18888])

    def test_service_environment_supplies_port_when_execstart_has_none(self):
        self.snapshot = self.snapshot.replace(" --port 18888", "")
        self.assertEqual(self.run_body()[0], 0)
        self.assertEqual([urlsplit(url).port for url in self.http[:2]], [19999, 19999])

    def test_service_and_http_failures_reach_launcher_as_nonzero(self):
        for failure in ("unit", "healthz", "readyz"):
            with self.subTest(failure=failure):
                snapshot, gateway = self.snapshot, dict(self.gateway)
                if failure == "unit":
                    self.snapshot = self.snapshot.replace("ActiveState=active", "ActiveState=failed")
                else:
                    self.gateway["/" + failure] = {"ok": False, "ready": False}
                code, output, errors = self.run_body()
                self.assertEqual(code, 1)
                self.assertEqual(output, "")
                self.assertIn({"unit": "not active/running", "healthz": "healthz refused",
                               "readyz": "readyz refused"}[failure], errors)
                self.snapshot, self.gateway = snapshot, gateway

    def test_transport_and_malformed_json_failures_are_reported(self):
        for error, expected in (
            (HTTPError("http://127.0.0.1/readyz", 503, "Unavailable", {}, None), "503"),
            (URLError("connection refused"), "connection refused"),
            (None, "Expecting value"),
        ):
            with self.subTest(error=expected):
                self.transport_error = error
                self.gateway["/readyz"] = b"not JSON"
                code, output, errors = self.run_body()
                self.assertEqual((code, output), (1, ""))
                self.assertIn(expected, errors)

    def test_missing_stalled_invalid_or_cross_target_metrics_fail(self):
        for failure in ("missing", "ambiguous", "stalled", "nonfinite", "negative", "target", "query"):
            with self.subTest(failure=failure):
                original = json.loads(json.dumps(self.replies))
                row = self.replies[0]["data"]["result"][0]
                if failure == "missing":
                    self.replies[0]["data"]["result"] = []
                elif failure == "ambiguous":
                    self.replies[0]["data"]["result"].append(dict(row))
                elif failure == "target":
                    self.replies[1]["data"]["result"][0]["metric"]["instance"] = "127.0.0.1:9465"
                elif failure == "query":
                    self.replies[0] = {"status": "error"}
                else:
                    row["value"][1] = {"stalled": "0", "nonfinite": "NaN", "negative": "-1"}[failure]
                code, output, errors = self.run_body()
                self.assertEqual(code, 1)
                self.assertEqual(output, "")
                self.assertIn({"missing": "missing or ambiguous", "ambiguous": "missing or ambiguous",
                               "stalled": "invalid or stalled", "nonfinite": "invalid or stalled",
                               "negative": "invalid or stalled", "target": "different scrape targets",
                               "query": "Prometheus query failed"}[failure], errors)
                self.replies = original


if __name__ == "__main__":
    unittest.main()
