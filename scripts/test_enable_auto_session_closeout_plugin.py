#!/usr/bin/env python3
from __future__ import annotations

import argparse
import unittest
from pathlib import Path
from unittest import mock

import enable_auto_session_closeout_plugin as plugin_enable


class EnableAutoSessionCloseoutPluginTests(unittest.TestCase):
    def build_args(self, workspace: str = "/tmp/workspace") -> argparse.Namespace:
        return argparse.Namespace(
            config=Path("/tmp/openclaw.json"),
            workspace=Path(workspace),
            agent_id=["main"],
            trigger=["user"],
            min_items=2,
            timeout_seconds=20,
            python_bin=None,
            no_apply_closeout=False,
            no_apply_memory=False,
            dry_run=False,
        )

    def test_update_config_adds_allow_entry_and_load_path(self):
        args = self.build_args("/tmp/ws-a")
        updated = plugin_enable.update_config(
            {
                "plugins": {
                    "allow": ["discord"],
                    "entries": {"discord": {"enabled": True}},
                }
            },
            args,
        )

        plugin_dir = str((args.workspace / ".openclaw" / "extensions" / plugin_enable.PLUGIN_ID).resolve())
        self.assertIn(plugin_enable.PLUGIN_ID, updated["plugins"]["allow"])
        self.assertIn(plugin_dir, updated["plugins"]["load"]["paths"])
        self.assertTrue(updated["plugins"]["entries"][plugin_enable.PLUGIN_ID]["enabled"])

    def test_update_config_preserves_existing_load_paths_without_duplicates(self):
        args = self.build_args("/tmp/ws-b")
        plugin_dir = str((args.workspace / ".openclaw" / "extensions" / plugin_enable.PLUGIN_ID).resolve())
        updated = plugin_enable.update_config(
            {
                "plugins": {
                    "allow": [plugin_enable.PLUGIN_ID],
                    "load": {"paths": [plugin_dir, "/opt/custom-plugin"]},
                    "entries": {
                        plugin_enable.PLUGIN_ID: {
                            "enabled": True,
                            "config": {"minItems": 9},
                        }
                    },
                }
            },
            args,
        )

        self.assertEqual(
            updated["plugins"]["load"]["paths"],
            [plugin_dir, "/opt/custom-plugin"],
        )
        self.assertEqual(
            updated["plugins"]["entries"][plugin_enable.PLUGIN_ID]["config"]["minItems"],
            2,
        )

    def test_build_parser_defaults_follow_openclaw_home_env(self):
        with mock.patch.dict("os.environ", {"OPENCLAW_HOME": "/tmp/oc-home"}, clear=False):
            parser = plugin_enable.build_parser()
            args = parser.parse_args([])

        self.assertEqual(args.config, Path("/tmp/oc-home/openclaw.json"))
        self.assertEqual(args.workspace, Path("/tmp/oc-home/workspace"))


if __name__ == "__main__":
    unittest.main()
