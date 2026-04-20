"""Tests for openclaw-guard."""
import asyncio, unittest, json, hashlib, os, tempfile
from openclaw_guard.masking import mask_body, mask_dict
from openclaw_guard.permissions import check_permission
from openclaw_guard.config import hash_token, add_user, load_config, init_config
from openclaw_guard.audit import AuditLog

ROLES = {
    "admin": {"permissions": ["*"]},
    "user": {"permissions": ["chat", "tools", "skills", "cron.read"],
             "mask_fields": ["api_key", "token", "secret", "password"]},
    "guest": {"permissions": ["chat"]},
}

class TestPermissions(unittest.TestCase):
    def test_admin_wildcard(self):
        self.assertTrue(check_permission(ROLES, "admin", "/config/secrets"))
        self.assertTrue(check_permission(ROLES, "admin", "/anything"))

    def test_user_allowed(self):
        self.assertTrue(check_permission(ROLES, "user", "/chat/send"))
        self.assertTrue(check_permission(ROLES, "user", "/tools/list"))
        self.assertTrue(check_permission(ROLES, "user", "/skills/weather"))

    def test_user_denied(self):
        self.assertFalse(check_permission(ROLES, "user", "/config/secrets"))

    def test_guest_limited(self):
        self.assertTrue(check_permission(ROLES, "guest", "/chat/send"))
        self.assertFalse(check_permission(ROLES, "guest", "/tools/list"))
        self.assertFalse(check_permission(ROLES, "guest", "/config/anything"))

    def test_unknown_role(self):
        self.assertFalse(check_permission(ROLES, "nobody", "/chat"))

class TestMasking(unittest.TestCase):
    def test_mask_sensitive(self):
        data = {"openai_api_key": "sk-abc123xyz", "name": "test"}
        result = mask_dict(data, ["api_key"])
        self.assertNotEqual(result["openai_api_key"], "sk-abc123xyz")
        self.assertIn("*", result["openai_api_key"])
        self.assertEqual(result["name"], "test")

    def test_mask_nested(self):
        data = {"config": {"secret_token": "tok-999888", "label": "ok"}}
        result = mask_dict(data, ["token", "secret"])
        self.assertIn("*", result["config"]["secret_token"])
        self.assertEqual(result["config"]["label"], "ok")

    def test_mask_body_json(self):
        body = json.dumps({"password": "hunter2", "user": "bob"}).encode()
        result = mask_body(body, ["password"])
        parsed = json.loads(result)
        self.assertIn("*", parsed["password"])
        self.assertEqual(parsed["user"], "bob")

    def test_mask_body_non_json(self):
        body = b"not json"
        self.assertEqual(mask_body(body, ["password"]), body)

    def test_no_fields(self):
        body = json.dumps({"secret": "x"}).encode()
        self.assertEqual(mask_body(body, []), body)

class TestTokenHash(unittest.TestCase):
    def test_hash_deterministic(self):
        self.assertEqual(hash_token("test"), hash_token("test"))

    def test_hash_different(self):
        self.assertNotEqual(hash_token("a"), hash_token("b"))

    def test_hash_is_salted_sha256(self):
        expected = hashlib.sha256(b"openclaw-guard-v1:hello").hexdigest()
        self.assertEqual(hash_token("hello"), expected)


class TestAuditLog(unittest.TestCase):
    def test_async_log_writes_jsonl(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "test.log")
            audit = AuditLog({"audit": {"enabled": True, "file": path}})
            asyncio.run(audit.log("alice", "GET", "/chat", "ok"))
            with open(path) as f:
                entry = json.loads(f.readline())
            self.assertEqual(entry["user"], "alice")
            self.assertEqual(entry["action"], "GET")
            self.assertEqual(entry["status"], "ok")

    def test_async_log_noop_when_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "test.log")
            audit = AuditLog({"audit": {"enabled": False, "file": path}})
            asyncio.run(audit.log("alice", "GET", "/chat", "ok"))
            self.assertFalse(os.path.exists(path))


class TestAddUserRoleValidation(unittest.TestCase):
    def test_rejects_unknown_role(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "guard.yaml")
            init_config(path)
            cfg_before = load_config(path)
            users_before = len(cfg_before["users"])
            add_user(path, "bob", "superadmin")
            cfg_after = load_config(path)
            self.assertEqual(len(cfg_after["users"]), users_before)

    def test_accepts_valid_role(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "guard.yaml")
            init_config(path)
            add_user(path, "alice", "admin")
            cfg = load_config(path)
            added = [u for u in cfg["users"] if u["name"] == "alice"]
            self.assertEqual(len(added), 1)
            self.assertEqual(added[0]["role"], "admin")

if __name__ == "__main__":
    unittest.main()
