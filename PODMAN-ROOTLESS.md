# Running rootless with podman

If you are running via podman as non-root and want to use bind mounts from your host you will need to set:

```
OPENCLAW_VOLUME_OPTS
```

## Values you may want to use depending on your needs

- `OPENCLAW_VOLUME_OPTS=":rw"` (mount as read/write, may have issues with user id mismatch between container and host)
- `OPENCLAW_VOLUME_OPTS=":U"` (mount with UIDs translated from host into container, this is probably what you want to use)
- `OPENCLAW_VOLUME_OPTS=":Z"` (handle SELinux labelling, eg: `user_home_t` -> `container_t`)

### You can also combine options if required:

Example:

```
OPENCLAW_VOLUME_OPTS=":U,Z"
```
