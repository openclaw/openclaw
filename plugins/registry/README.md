# Plugin Registry (local)

Minimal local registry for controller and filter plugins. The registry is a JSON file stored alongside the manager and is **not** a downloader or remote index. It only lists metadata for plugins that already exist on disk.

## Registry format
`registry.json`:
```json
{
  "plugins": [
    {
      "name": "example_kalman",
      "type": "filter",
      "path": "plugins/controller_base/example_kalman.py"
    }
  ]
}
```

## API
- `list_plugins()` → list of plugin metadata entries
- `load_plugin(name)` → single metadata entry (no dynamic loading)

## Quick Test
Command:
```bash
python -m plugins.registry.self_test
```
Expected:
```
REGISTRY TEST PASSED
```
