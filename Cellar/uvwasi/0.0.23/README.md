# uvwasi

**This project does not currently provide the comprehensive file system security
properties provided by some WASI runtimes. Full support for secure file system sandboxing
may or may not be implemented in future. In the mean time, do not rely on it to run untrusted code.**

`uvwasi` implements the [WASI][] system call API, so that WebAssembly
runtimes can easily implement WASI calls. Under the hood, `uvwasi`
leverages [libuv][] where possible for maximum portability.

                                  |
    WebAssembly code              |      WebAssembly application code
                                  |                 |
                                  |                 v
                                  | WASI syscalls (inserted by compiler toolchain)
                                  |                 |
    ------------------------------+                 |
                                  |                 v
    WebAssembly runtime (Node.js) |    uvwasi (implementation of WASI)
                                  |                 |
                                  |                 v
                                  |               libuv
                                  |                 |
                                  |                 v
                                  |        platform-specific calls
                                  |

_(Hence uvwasi isn't for making C-programs-that-use-libuv-APIs execute on
WASI runtimes. That would either be a new platform added by libuv, or done
through POSIX emulation by the Emscripten or wasi-sdk toolchains.)_

## Building Locally

To build with [CMake](https://cmake.org/):

```sh
$ mkdir -p out/cmake ; cd out/cmake   # create build directory
$ cmake ../.. -DBUILD_TESTING=ON      # generate project with test
$ cmake --build .                     # build
$ ctest -C Debug --output-on-failure  # run tests
```

## Example Usage

```c
#include <stdlib.h>
#include <assert.h>
#include "uv.h"
#include "uvwasi.h"

int main(void) {
  uvwasi_t uvwasi;
  uvwasi_options_t init_options;
  uvwasi_errno_t err;

  /* Setup the initialization options. */
  init_options.in = 0;
  init_options.out = 1;
  init_options.err = 2;
  init_options.fd_table_size = 3;
  init_options.argc = 3;
  init_options.argv = calloc(3, sizeof(char*));
  init_options.argv[0] = "--foo=bar";
  init_options.argv[1] = "-baz";
  init_options.argv[2] = "100";
  init_options.envp = NULL;
  init_options.preopenc = 1;
  init_options.preopens = calloc(1, sizeof(uvwasi_preopen_t));
  init_options.preopens[0].mapped_path = "/var";
  init_options.preopens[0].real_path = ".";
  init_options.allocator = NULL;

  /* Initialize the sandbox. */
  err = uvwasi_init(&uvwasi, &init_options);
  assert(err == UVWASI_ESUCCESS);

  /* TODO(cjihrig): Show an example system call or two. */

  /* Clean up resources. */
  uvwasi_destroy(&uvwasi);
  return 0;
}
```

## API

The WASI API is versioned. This documentation is based on the WASI [preview 1][]
snapshot. `uvwasi` implements the WASI system call API with the following
additions/modifications:

- Each system call takes an additional `uvwasi_t*` as its first argument. The
  `uvwasi_t` is the sandbox under which system calls are issued. Each `uvwasi_t`
  can have different command line arguments, environment variables, preopened
  directories, file descriptor mappings, etc. This allows one controlling
  process to host multiple WASI applications simultaneously.
- Each system call returns a `uvwasi_errno_t`. This appears to be expected of
  WASI system calls, but it is not explicitly part of the official API docs.
  This detail is explicitly documented here.
- Additional functions and data types are provided for interacting with WASI
  sandboxes and the `uvwasi` library. These APIs are documented in the
  Unofficial APIs section below.

### Unofficial APIs

This section contains data types and functions for working with `uvwasi`. They
are not part of the official WASI API, but are used to embed `uvwasi`.

### <a href="#version_major" name="version_major"></a>`UVWASI_VERSION_MAJOR`

The major release version of the `uvwasi` library. `uvwasi` follows semantic
versioning. Changes to this value represent breaking changes in the public API.

### <a href="#version_minor" name="version_minor"></a>`UVWASI_VERSION_MINOR`

The minor release version of the `uvwasi` library. `uvwasi` follows semantic
versioning. Changes to this value represent feature additions in the public API.

### <a href="#version_patch" name="version_patch"></a>`UVWASI_VERSION_PATCH`

The patch release version of the `uvwasi` library. `uvwasi` follows semantic
versioning. Changes to this value represent bug fixes in the public API.

### <a href="#version_hex" name="version_hex"></a>`UVWASI_VERSION_HEX`

The major, minor, and patch versions of the `uvwasi` library encoded as a single
integer value.

### <a href="#version_string" name="version_string"></a>`UVWASI_VERSION_STRING`

The major, minor, and patch versions of the `uvwasi` library encoded as a
version string.

### <a href="#version_wasi" name="version_wasi"></a>`UVWASI_VERSION_WASI`

The version of the WASI API targeted by `uvwasi`.

### <a href="#uvwasi_t" name="uvwasi_t"></a>`uvwasi_t`

An individual WASI sandbox instance.

```c
typedef struct uvwasi_s {
  struct uvwasi_fd_table_t fds;
  uvwasi_size_t argc;
  char** argv;
  char* argv_buf;
  uvwasi_size_t argv_buf_size;
  uvwasi_size_t envc;
  char** env;
  char* env_buf;
  uvwasi_size_t env_buf_size;
} uvwasi_t;
```

### <a href="#uvwasi_preopen_t" name="uvwasi_preopen_t"></a>`uvwasi_preopen_t`

A data structure used to map a directory path within a WASI sandbox to a
directory path on the WASI host platform.

```c
typedef struct uvwasi_preopen_s {
  char* mapped_path;
  char* real_path;
} uvwasi_preopen_t;
```

### <a href="#uvwasi_options_t" name="uvwasi_options_t"></a>`uvwasi_options_t`

A data structure used to pass configuration options to `uvwasi_init()`.

```c
typedef struct uvwasi_options_s {
  uvwasi_size_t fd_table_size;
  uvwasi_size_t preopenc;
  uvwasi_preopen_t* preopens;
  uvwasi_size_t argc;
  char** argv;
  char** envp;
  uvwasi_fd_t in;
  uvwasi_fd_t out;
  uvwasi_fd_t err;
  const uvwasi_mem_t* allocator;
} uvwasi_options_t;
```

### <a href="#uvwasi_init" name="uvwasi_init"></a>`uvwasi_init()`

Initializes a sandbox represented by a `uvwasi_t` using the options represented
by a `uvwasi_options_t`.

Inputs:

- <a href="#uvwasi_init.uvwasi" name="uvwasi_init.uvwasi"></a><code>[\_\_wasi_t](#uvwasi_t) <strong>uvwasi</strong></code>

  The sandbox to initialize.

- <a href="#uvwasi_init.options" name="uvwasi_init.options"></a><code>[\_\_wasi_options_t](#uvwasi_options_t) <strong>options</strong></code>

  Configuration options used when initializing the sandbox.

Outputs:

- None

Returns:

- <a href="#uvwasi_init.return" name="uvwasi_init.return"></a><code>[\_\_wasi_errno_t](#errno) <strong>errno</strong></code>

  A WASI errno.

### <a href="#uvwasi_destroy" name="uvwasi_destroy"></a>`uvwasi_destroy()`

Cleans up resources related to a WASI sandbox. This function notably does not
return an error code.

Inputs:

- <a href="#uvwasi_destroy.uvwasi" name="uvwasi_destroy.uvwasi"></a><code>[\_\_wasi_t](#uvwasi_t) <strong>uvwasi</strong></code>

  The sandbox to clean up.

Outputs:

- None

Returns:

- None

### System Calls

This section has been adapted from the official WASI API documentation.

- [`uvwasi_args_get()`](#args_get)
- [`uvwasi_args_sizes_get()`](#args_sizes_get)
- [`uvwasi_clock_res_get()`](#clock_res_get)
- [`uvwasi_clock_time_get()`](#clock_time_get)
- [`uvwasi_environ_get()`](#environ_get)
- [`uvwasi_environ_sizes_get()`](#environ_sizes_get)
- [`uvwasi_fd_advise()`](#fd_advise)
- [`uvwasi_fd_allocate()`](#fd_allocate)
- [`uvwasi_fd_close()`](#fd_close)
- [`uvwasi_fd_datasync()`](#fd_datasync)
- [`uvwasi_fd_fdstat_get()`](#fd_fdstat_get)
- [`uvwasi_fd_fdstat_set_flags()`](#fd_fdstat_set_flags)
- [`uvwasi_fd_fdstat_set_rights()`](#fd_fdstat_set_rights)
- [`uvwasi_fd_filestat_get()`](#fd_filestat_get)
- [`uvwasi_fd_filestat_set_size()`](#fd_filestat_set_size)
- [`uvwasi_fd_filestat_set_times()`](#fd_filestat_set_times)
- [`uvwasi_fd_pread()`](#fd_pread)
- [`uvwasi_fd_prestat_get()`](#fd_prestat_get)
- [`uvwasi_fd_prestat_dir_name()`](#fd_prestat_dir_name)
- [`uvwasi_fd_pwrite()`](#fd_pwrite)
- [`uvwasi_fd_read()`](#fd_read)
- [`uvwasi_fd_readdir()`](#fd_readdir)
- [`uvwasi_fd_renumber()`](#fd_renumber)
- [`uvwasi_fd_seek()`](#fd_seek)
- [`uvwasi_fd_sync()`](#fd_sync)
- [`uvwasi_fd_tell()`](#fd_tell)
- [`uvwasi_fd_write()`](#fd_write)
- [`uvwasi_path_create_directory()`](#path_create_directory)
- [`uvwasi_path_filestat_get()`](#path_filestat_get)
- [`uvwasi_path_filestat_set_times()`](#path_filestat_set_times)
- [`uvwasi_path_link()`](#path_link)
- [`uvwasi_path_open()`](#path_open)
- [`uvwasi_path_readlink()`](#path_readlink)
- [`uvwasi_path_remove_directory()`](#path_remove_directory)
- [`uvwasi_path_rename()`](#path_rename)
- [`uvwasi_path_symlink()`](#path_symlink)
- [`uvwasi_path_unlink_file()`](#path_unlink_file)
- [`uvwasi_poll_oneoff()`](#poll_oneoff)
- [`uvwasi_proc_exit()`](#proc_exit)
- [`uvwasi_proc_raise()`](#proc_raise)
- [`uvwasi_random_get()`](#random_get)
- [`uvwasi_sched_yield()`](#sched_yield)
- [`uvwasi_sock_recv()`](#sock_recv)
- [`uvwasi_sock_send()`](#sock_send)
- [`uvwasi_sock_shutdown()`](#sock_shutdown)

### <a href="#args_get" name="args_get"></a>`uvwasi_args_get()`

Read command-line argument data.

The sizes of the buffers should match that returned by [`uvwasi_args_sizes_get()`](#args_sizes_get).

Inputs:

- <a href="#args_get.argv" name="args_get.argv"></a><code>char \*\*<strong>argv</strong></code>

  A pointer to a buffer to write the argument pointers.

- <a href="#args_get.argv_buf" name="args_get.argv_buf"></a><code>char \*<strong>argv_buf</strong></code>

  A pointer to a buffer to write the argument string data.

### <a href="#args_sizes_get" name="args_sizes_get"></a>`uvwasi_args_sizes_get()`

Return command-line argument data sizes.

Outputs:

- <a href="#args_sizes_get.argc" name="args_sizes_get.argc"></a><code>\_\_wasi_size_t \*<strong>argc</strong></code>

  The number of arguments.

- <a href="#args_sizes_get.argv_buf_size" name="args_sizes_get.argv_buf_size"></a><code>\_\_wasi_size_t \*<strong>argv_buf_size</strong></code>

  The size of the argument string data.

### <a href="#clock_res_get" name="clock_res_get"></a>`uvwasi_clock_res_get()`

Return the resolution of a clock.

Implementations are required to provide a non-zero value for supported clocks.
For unsupported clocks, return [`UVWASI_EINVAL`](#errno.inval).

Note: This is similar to `clock_getres` in POSIX.

Inputs:

- <a href="#clock_res_get.clock_id" name="clock_res_get.clock_id"></a><code>[\_\_wasi_clockid_t](#clockid) <strong>clock_id</strong></code>

  The clock for which to return the resolution.

Outputs:

- <a href="#clock_res_get.resolution" name="clock_res_get.resolution"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>resolution</strong></code>

  The resolution of the clock.

### <a href="#clock_time_get" name="clock_time_get"></a>`uvwasi_clock_time_get()`

Return the time value of a clock.

Note: This is similar to `clock_gettime` in POSIX.

Inputs:

- <a href="#clock_time_get.clock_id" name="clock_time_get.clock_id"></a><code>[\_\_wasi_clockid_t](#clockid) <strong>clock_id</strong></code>

  The clock for which to return the time.

- <a href="#clock_time_get.precision" name="clock_time_get.precision"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>precision</strong></code>

  The maximum lag (exclusive) that the returned
  time value may have, compared to its actual
  value.

Outputs:

- <a href="#clock_time_get.time" name="clock_time_get.time"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>time</strong></code>

  The time value of the clock.

### <a href="#environ_get" name="environ_get"></a>`uvwasi_environ_get()`

Read environment variable data.

The sizes of the buffers should match that returned by [`uvwasi_environ_sizes_get()`](#environ_sizes_get).

Inputs:

- <a href="#environ_get.environ" name="environ_get.environ"></a><code>char \*\*<strong>environ</strong></code>

  A pointer to a buffer to write the environment variable pointers.

- <a href="#environ_get.environ_buf" name="environ_get.environ_buf"></a><code>char \*<strong>environ_buf</strong></code>

  A pointer to a buffer to write the environment variable string data.

### <a href="#environ_sizes_get" name="environ_sizes_get"></a>`uvwasi_environ_sizes_get()`

Return command-line argument data sizes.

Outputs:

- <a href="#environ_sizes_get.environ_count" name="environ_sizes_get.environ_count"></a><code>\_\_wasi_size_t \*<strong>environ_count</strong></code>

  The number of environment variables.

- <a href="#environ_sizes_get.environ_buf_size" name="environ_sizes_get.environ_buf_size"></a><code>\_\_wasi_size_t \*<strong>environ_buf_size</strong></code>

  The size of the environment variable string data.

### <a href="#fd_advise" name="fd_advise"></a>`uvwasi_fd_advise()`

Provide file advisory information on a file descriptor.

Note: This is similar to `posix_fadvise` in POSIX.

Inputs:

- <a href="#fd_advise.fd" name="fd_advise.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor for the file for which to provide file advisory information.

- <a href="#fd_advise.offset" name="fd_advise.offset"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>offset</strong></code>

  The offset within the file to which the advisory applies.

- <a href="#fd_advise.len" name="fd_advise.len"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>len</strong></code>

  The length of the region to which the advisory applies.

- <a href="#fd_advise.advice" name="fd_advise.advice"></a><code>[\_\_wasi_advice_t](#advice) <strong>advice</strong></code>

  The advice.

### <a href="#fd_allocate" name="fd_allocate"></a>`uvwasi_fd_allocate()`

Force the allocation of space in a file.

Note: This is similar to `posix_fallocate` in POSIX.

Inputs:

- <a href="#fd_allocate.fd" name="fd_allocate.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor for the file in which to allocate space.

- <a href="#fd_allocate.offset" name="fd_allocate.offset"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>offset</strong></code>

  The offset at which to start the allocation.

- <a href="#fd_allocate.len" name="fd_allocate.len"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>len</strong></code>

  The length of the area that is allocated.

### <a href="#fd_close" name="fd_close"></a>`uvwasi_fd_close()`

Close a file descriptor.

Note: This is similar to `close` in POSIX.

Inputs:

- <a href="#fd_close.fd" name="fd_close.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to close.

### <a href="#fd_datasync" name="fd_datasync"></a>`uvwasi_fd_datasync()`

Synchronize the data of a file to disk.

Note: This is similar to `fdatasync` in POSIX.

Inputs:

- <a href="#fd_datasync.fd" name="fd_datasync.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor of the file to synchronize to disk.

### <a href="#fd_fdstat_get" name="fd_fdstat_get"></a>`uvwasi_fd_fdstat_get()`

Get the attributes of a file descriptor.

Note: This returns similar flags to `fsync(fd, F_GETFL)` in POSIX, as well
as additional fields.

Inputs:

- <a href="#fd_fdstat_get.fd" name="fd_fdstat_get.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to inspect.

- <a href="#fd_fdstat_get.buf" name="fd_fdstat_get.buf"></a><code>[\_\_wasi_fdstat_t](#fdstat) \*<strong>buf</strong></code>

  The buffer where the file descriptor's attributes are stored.

### <a href="#fd_fdstat_set_flags" name="fd_fdstat_set_flags"></a>`uvwasi_fd_fdstat_set_flags()`

Adjust the flags associated with a file descriptor.

Note: This is similar to `fcntl(fd, F_SETFL, flags)` in POSIX.

Inputs:

- <a href="#fd_fdstat_set_flags.fd" name="fd_fdstat_set_flags.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to operate on.

- <a href="#fd_fdstat_set_flags.flags" name="fd_fdstat_set_flags.flags"></a><code>[\_\_wasi_fdflags_t](#fdflags) <strong>flags</strong></code>

  The desired values of the file descriptor
  flags.

### <a href="#fd_fdstat_set_rights" name="fd_fdstat_set_rights"></a>`uvwasi_fd_fdstat_set_rights()`

Adjust the rights associated with a file descriptor.

This can only be used to remove rights, and returns
[`UVWASI_ENOTCAPABLE`](#errno.notcapable) if called in a way that would attempt
to add rights.

Inputs:

- <a href="#fd_fdstat_set_rights.fd" name="fd_fdstat_set_rights.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to operate on.

- <a href="#fd_fdstat_set_rights.fs_rights_base" name="fd_fdstat_set_rights.fs_rights_base"></a><code>[\_\_wasi_rights_t](#rights) <strong>fs_rights_base</strong></code> and <a href="#fd_fdstat_set_rights.fs_rights_inheriting" name="fd_fdstat_set_rights.fs_rights_inheriting"></a><code>[\_\_wasi_rights_t](#rights) <strong>fs_rights_inheriting</strong></code>

  The desired rights of the file descriptor.

### <a href="#fd_filestat_get" name="fd_filestat_get"></a>`uvwasi_fd_filestat_get()`

Return the attributes of an open file.

Inputs:

- <a href="#fd_filestat_get.fd" name="fd_filestat_get.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to inspect.

- <a href="#fd_filestat_get.buf" name="fd_filestat_get.buf"></a><code>[\_\_wasi_filestat_t](#filestat) \*<strong>buf</strong></code>

  The buffer where the file's attributes are
  stored.

### <a href="#fd_filestat_set_size" name="fd_filestat_set_size"></a>`uvwasi_fd_filestat_set_size()`

Adjust the size of an open file. If this increases the file's size, the extra
bytes are filled with zeros.

Note: This is similar to `ftruncate` in POSIX.

Inputs:

- <a href="#fd_filestat_set_size.fd" name="fd_filestat_set_size.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  A file descriptor for the file to adjust.

- <a href="#fd_filestat_set_size.st_size" name="fd_filestat_set_size.st_size"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>st_size</strong></code>

  The desired file size.

### <a href="#fd_filestat_set_times" name="fd_filestat_set_times"></a>`uvwasi_fd_filestat_set_times()`

Adjust the timestamps of an open file or directory.

Note: This is similar to `futimens` in POSIX.

Inputs:

- <a href="#fd_filestat_set_times.fd" name="fd_filestat_set_times.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to operate on.

- <a href="#fd_filestat_set_times.st_atim" name="fd_filestat_set_times.st_atim"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>st_atim</strong></code>

  The desired values of the data access timestamp.

- <a href="#fd_filestat_set_times.st_mtim" name="fd_filestat_set_times.st_mtim"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>st_mtim</strong></code>

  The desired values of the data modification timestamp.

- <a href="#fd_filestat_set_times.fst_flags" name="fd_filestat_set_times.fst_flags"></a><code>[\_\_wasi_fstflags_t](#fstflags) <strong>fst_flags</strong></code>

  A bitmask indicating which timestamps to adjust.

### <a href="#fd_pread" name="fd_pread"></a>`uvwasi_fd_pread()`

Read from a file descriptor, without using and updating the
file descriptor's offset.

Note: This is similar to `preadv` in POSIX.

Inputs:

- <a href="#fd_pread.fd" name="fd_pread.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor from which to read data.

- <a href="#fd_pread.iovs" name="fd_pread.iovs"></a><code>const [\_\_wasi_iovec_t](#iovec) \*<strong>iovs</strong></code> and <a href="#fd_pread.iovs_len" name="fd_pread.iovs_len"></a><code>\_\_wasi_size_t <strong>iovs_len</strong></code>

  List of scatter/gather vectors in which to store data.

- <a href="#fd_pread.offset" name="fd_pread.offset"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>offset</strong></code>

  The offset within the file at which to read.

Outputs:

- <a href="#fd_pread.nread" name="fd_pread.nread"></a><code>\_\_wasi_size_t <strong>nread</strong></code>

  The number of bytes read.

### <a href="#fd_prestat_get" name="fd_prestat_get"></a>`uvwasi_fd_prestat_get()`

Return a description of the given preopened file descriptor.

Inputs:

- <a href="#fd_prestat_get.fd" name="fd_prestat_get.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor about which to retrieve information.

- <a href="#fd_prestat_get.buf" name="fd_prestat_get.buf"></a><code>[\_\_wasi_prestat_t](#prestat) \*<strong>buf</strong></code>

  The buffer where the description is stored.

### <a href="#fd_prestat_dir_name" name="fd_prestat_dir_name"></a>`uvwasi_fd_prestat_dir_name()`

Return a description of the given preopened file descriptor.

Inputs:

- <a href="#fd_prestat_dir_name.fd" name="fd_prestat_dir_name.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor about which to retrieve information.

- <a href="#fd_prestat_dir_name.path" name="fd_prestat_dir_name.path"></a><code>const char \*<strong>path</strong></code> and <a href="#fd_prestat_dir_name.path_len" name="fd_prestat_dir_name.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  A buffer into which to write the preopened directory name.

### <a href="#fd_pwrite" name="fd_pwrite"></a>`uvwasi_fd_pwrite()`

Write to a file descriptor, without using and updating the
file descriptor's offset.

Note: This is similar to `pwritev` in POSIX.

Inputs:

- <a href="#fd_pwrite.fd" name="fd_pwrite.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to which to write data.

- <a href="#fd_pwrite.iovs" name="fd_pwrite.iovs"></a><code>const [\_\_wasi_ciovec_t](#ciovec) \*<strong>iovs</strong></code> and <a href="#fd_pwrite.iovs_len" name="fd_pwrite.iovs_len"></a><code>\_\_wasi_size_t <strong>iovs_len</strong></code>

  List of scatter/gather vectors from which to retrieve data.

- <a href="#fd_pwrite.offset" name="fd_pwrite.offset"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>offset</strong></code>

  The offset within the file at which to write.

Outputs:

- <a href="#fd_pwrite.nwritten" name="fd_pwrite.nwritten"></a><code>\_\_wasi_size_t <strong>nwritten</strong></code>

  The number of bytes written.

### <a href="#fd_read" name="fd_read"></a>`uvwasi_fd_read()`

Read from a file descriptor.

Note: This is similar to `readv` in POSIX.

Inputs:

- <a href="#fd_read.fd" name="fd_read.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor from which to read data.

- <a href="#fd_read.iovs" name="fd_read.iovs"></a><code>const [\_\_wasi_iovec_t](#iovec) \*<strong>iovs</strong></code> and <a href="#fd_read.iovs_len" name="fd_read.iovs_len"></a><code>\_\_wasi_size_t <strong>iovs_len</strong></code>

  List of scatter/gather vectors to which to store data.

Outputs:

- <a href="#fd_read.nread" name="fd_read.nread"></a><code>\_\_wasi_size_t <strong>nread</strong></code>

  The number of bytes read.

### <a href="#fd_readdir" name="fd_readdir"></a>`uvwasi_fd_readdir()`

Read directory entries from a directory.

When successful, the contents of the output buffer consist of
a sequence of directory entries. Each directory entry consists
of a [`uvwasi_dirent_t`](#dirent) object, followed by [`uvwasi_dirent_t::d_namlen`](#dirent.d_namlen) bytes
holding the name of the directory entry.

This function fills the output buffer as much as possible,
potentially truncating the last directory entry. This allows
the caller to grow its read buffer size in case it's too small
to fit a single large directory entry, or skip the oversized
directory entry.

Inputs:

- <a href="#fd_readdir.fd" name="fd_readdir.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The directory from which to read the directory
  entries.

- <a href="#fd_readdir.buf" name="fd_readdir.buf"></a><code>void \*<strong>buf</strong></code> and <a href="#fd_readdir.buf_len" name="fd_readdir.buf_len"></a><code>\_\_wasi_size_t <strong>buf_len</strong></code>

  The buffer where directory entries are stored.

- <a href="#fd_readdir.cookie" name="fd_readdir.cookie"></a><code>[\_\_wasi_dircookie_t](#dircookie) <strong>cookie</strong></code>

  The location within the directory to start
  reading.

Outputs:

- <a href="#fd_readdir.bufused" name="fd_readdir.bufused"></a><code>\_\_wasi_size_t <strong>bufused</strong></code>

  The number of bytes stored in the read buffer.
  If less than the size of the read buffer, the
  end of the directory has been reached.

### <a href="#fd_renumber" name="fd_renumber"></a>`uvwasi_fd_renumber()`

Atomically replace a file descriptor by renumbering another
file descriptor.

Due to the strong focus on thread safety, this environment
does not provide a mechanism to duplicate or renumber a file
descriptor to an arbitrary number, like dup2(). This would be
prone to race conditions, as an actual file descriptor with the
same number could be allocated by a different thread at the same
time.

This function provides a way to atomically renumber file
descriptors, which would disappear if dup2() were to be
removed entirely.

Inputs:

- <a href="#fd_renumber.from" name="fd_renumber.from"></a><code>[\_\_wasi_fd_t](#fd) <strong>from</strong></code>

  The file descriptor to renumber.

- <a href="#fd_renumber.to" name="fd_renumber.to"></a><code>[\_\_wasi_fd_t](#fd) <strong>to</strong></code>

  The file descriptor to overwrite.

### <a href="#fd_seek" name="fd_seek"></a>`uvwasi_fd_seek()`

Move the offset of a file descriptor.

Note: This is similar to `lseek` in POSIX.

Inputs:

- <a href="#fd_seek.fd" name="fd_seek.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to operate on.

- <a href="#fd_seek.offset" name="fd_seek.offset"></a><code>[\_\_wasi_filedelta_t](#filedelta) <strong>offset</strong></code>

  The number of bytes to move.

- <a href="#fd_seek.whence" name="fd_seek.whence"></a><code>[\_\_wasi_whence_t](#whence) <strong>whence</strong></code>

  The base from which the offset is relative.

Outputs:

- <a href="#fd_seek.newoffset" name="fd_seek.newoffset"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>newoffset</strong></code>

  The new offset of the file descriptor,
  relative to the start of the file.

### <a href="#fd_sync" name="fd_sync"></a>`uvwasi_fd_sync()`

Synchronize the data and metadata of a file to disk.

Note: This is similar to `fsync` in POSIX.

Inputs:

- <a href="#fd_sync.fd" name="fd_sync.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor of the file containing the data
  and metadata to synchronize to disk.

### <a href="#fd_tell" name="fd_tell"></a>`uvwasi_fd_tell()`

Return the current offset of a file descriptor.

Note: This is similar to `lseek(fd, 0, SEEK_CUR)` in POSIX.

Inputs:

- <a href="#fd_tell.fd" name="fd_tell.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to inspect.

Outputs:

- <a href="#fd_tell.offset" name="fd_tell.offset"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>offset</strong></code>

  The current offset of the file descriptor, relative to the start of the file.

### <a href="#fd_write" name="fd_write"></a>`uvwasi_fd_write()`

Write to a file descriptor.

Note: This is similar to `writev` in POSIX.

Inputs:

- <a href="#fd_write.fd" name="fd_write.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor to which to write data.

- <a href="#fd_write.iovs" name="fd_write.iovs"></a><code>const [\_\_wasi_ciovec_t](#ciovec) \*<strong>iovs</strong></code> and <a href="#fd_write.iovs_len" name="fd_write.iovs_len"></a><code>\_\_wasi_size_t <strong>iovs_len</strong></code>

  List of scatter/gather vectors from which to retrieve data.

Outputs:

- <a href="#fd_write.nwritten" name="fd_write.nwritten"></a><code>\_\_wasi_size_t <strong>nwritten</strong></code>

  The number of bytes written.

### <a href="#path_create_directory" name="path_create_directory"></a>`uvwasi_path_create_directory()`

Create a directory.

Note: This is similar to `mkdirat` in POSIX.

Inputs:

- <a href="#path_create_directory.fd" name="path_create_directory.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_create_directory.path" name="path_create_directory.path"></a><code>const char \*<strong>path</strong></code> and <a href="#path_create_directory.path_len" name="path_create_directory.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  The path at which to create the directory.

### <a href="#path_filestat_get" name="path_filestat_get"></a>`uvwasi_path_filestat_get()`

Return the attributes of a file or directory.

Note: This is similar to `stat` in POSIX.

Inputs:

- <a href="#path_filestat_get.fd" name="path_filestat_get.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_filestat_get.flags" name="path_filestat_get.flags"></a><code>[\_\_wasi_lookupflags_t](#lookupflags) <strong>flags</strong></code>

  Flags determining the method of how the path is resolved.

- <a href="#path_filestat_get.path" name="path_filestat_get.path"></a><code>const char \*<strong>path</strong></code> and <a href="#path_filestat_get.path_len" name="path_filestat_get.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  The path of the file or directory to inspect.

- <a href="#path_filestat_get.buf" name="path_filestat_get.buf"></a><code>[\_\_wasi_filestat_t](#filestat) \*<strong>buf</strong></code>

  The buffer where the file's attributes are
  stored.

### <a href="#path_filestat_set_times" name="path_filestat_set_times"></a>`uvwasi_path_filestat_set_times()`

Adjust the timestamps of a file or directory.

Note: This is similar to `utimensat` in POSIX.

Inputs:

- <a href="#path_filestat_set_times.fd" name="path_filestat_set_times.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_filestat_set_times.flags" name="path_filestat_set_times.flags"></a><code>[\_\_wasi_lookupflags_t](#lookupflags) <strong>flags</strong></code>

  Flags determining the method of how the path is resolved.

- <a href="#path_filestat_set_times.path" name="path_filestat_set_times.path"></a><code>const char \*<strong>path</strong></code> and <a href="#path_filestat_set_times.path_len" name="path_filestat_set_times.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  The path of the file or directory to operate on.

- <a href="#path_filestat_set_times.st_atim" name="path_filestat_set_times.st_atim"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>st_atim</strong></code>

  The desired values of the data access timestamp.

- <a href="#path_filestat_set_times.st_mtim" name="path_filestat_set_times.st_mtim"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>st_mtim</strong></code>

  The desired values of the data modification timestamp.

- <a href="#path_filestat_set_times.fst_flags" name="path_filestat_set_times.fst_flags"></a><code>[\_\_wasi_fstflags_t](#fstflags) <strong>fst_flags</strong></code>

  A bitmask indicating which timestamps to adjust.

### <a href="#path_link" name="path_link"></a>`uvwasi_path_link()`

Create a hard link.

Note: This is similar to `linkat` in POSIX.

Inputs:

- <a href="#path_link.old_fd" name="path_link.old_fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>old_fd</strong></code>

  The working directory at which the resolution of the old path starts.

- <a href="#path_link.old_flags" name="path_link.old_flags"></a><code>[\_\_wasi_lookupflags_t](#lookupflags) <strong>old_flags</strong></code>

  Flags determining the method of how the path is resolved.

- <a href="#path_link.old_path" name="path_link.old_path"></a><code>const char \*<strong>old_path</strong></code> and <a href="#path_link.old_path_len" name="path_link.old_path_len"></a><code>\_\_wasi_size_t <strong>old_path_len</strong></code>

  The source path from which to link.

- <a href="#path_link.new_fd" name="path_link.new_fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>new_fd</strong></code>

  The working directory at which the resolution of the new path starts.

- <a href="#path_link.new_path" name="path_link.new_path"></a><code>const char \*<strong>new_path</strong></code> and <a href="#path_link.new_path_len" name="path_link.new_path_len"></a><code>\_\_wasi_size_t <strong>new_path_len</strong></code>

  The destination path at which to create the hard link.

### <a href="#path_open" name="path_open"></a>`uvwasi_path_open()`

Open a file or directory.

The returned file descriptor is not guaranteed to be the lowest-numbered
file descriptor not currently open; it is randomized to prevent
applications from depending on making assumptions about indexes, since
this is error-prone in multi-threaded contexts. The returned file
descriptor is guaranteed to be less than 2<sup>31</sup>.

Note: This is similar to `openat` in POSIX.

Inputs:

- <a href="#path_open.dirfd" name="path_open.dirfd"></a><code>[\_\_wasi_fd_t](#fd) <strong>dirfd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_open.dirflags" name="path_open.dirflags"></a><code>[\_\_wasi_lookupflags_t](#lookupflags) <strong>dirflags</strong></code>

  Flags determining the method of how the path is resolved.

- <a href="#path_open.path" name="path_open.path"></a><code>const char \*<strong>path</strong></code> and <a href="#path_open.path_len" name="path_open.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  The relative path of the file or directory to open, relative to
  the [`dirfd`](#path_open.dirfd) directory.

- <a href="#path_open.o_flags" name="path_open.o_flags"></a><code>[\_\_wasi_oflags_t](#oflags) <strong>o_flags</strong></code>

  The method by which to open the file.

- <a href="#path_open.fs_rights_base" name="path_open.fs_rights_base"></a><code>[\_\_wasi_rights_t](#rights) <strong>fs_rights_base</strong></code> and <a href="#path_open.fs_rights_inheriting" name="path_open.fs_rights_inheriting"></a><code>[\_\_wasi_rights_t](#rights) <strong>fs_rights_inheriting</strong></code>

  The initial rights of the newly created file descriptor. The
  implementation is allowed to return a file descriptor with fewer
  rights than specified, if and only if those rights do not apply
  to the type of file being opened.

  The _base_ rights are rights that will apply to operations using
  the file descriptor itself, while the _inheriting_ rights are
  rights that apply to file descriptors derived from it.

- <a href="#path_open.fs_flags" name="path_open.fs_flags"></a><code>[\_\_wasi_fdflags_t](#fdflags) <strong>fs_flags</strong></code>

  The initial flags of the file descriptor.

Outputs:

- <a href="#path_open.fd" name="path_open.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The file descriptor of the file that has been
  opened.

### <a href="#path_readlink" name="path_readlink"></a>`uvwasi_path_readlink()`

Read the contents of a symbolic link.

Note: This is similar to `readlinkat` in POSIX.

Inputs:

- <a href="#path_readlink.fd" name="path_readlink.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_readlink.path" name="path_readlink.path"></a><code>const char \*<strong>path</strong></code> and <a href="#path_readlink.path_len" name="path_readlink.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  The path of the symbolic link from which to read.

- <a href="#path_readlink.buf" name="path_readlink.buf"></a><code>char \*<strong>buf</strong></code> and <a href="#path_readlink.buf_len" name="path_readlink.buf_len"></a><code>\_\_wasi_size_t <strong>buf_len</strong></code>

  The buffer to which to write the contents of the symbolic link.

Outputs:

- <a href="#path_readlink.bufused" name="path_readlink.bufused"></a><code>\_\_wasi_size_t <strong>bufused</strong></code>

  The number of bytes placed in the buffer.

### <a href="#path_remove_directory" name="path_remove_directory"></a>`uvwasi_path_remove_directory()`

Remove a directory.

Return [`UVWASI_ENOTEMPTY`](#errno.notempty) if the directory is not empty.

Note: This is similar to `unlinkat(fd, path, AT_REMOVEDIR)` in POSIX.

Inputs:

- <a href="#path_remove_directory.fd" name="path_remove_directory.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_remove_directory.path" name="path_remove_directory.path"></a><code>const char \*<strong>path</strong></code> and <a href="#path_remove_directory.path_len" name="path_remove_directory.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  The path to a directory to remove.

### <a href="#path_rename" name="path_rename"></a>`uvwasi_path_rename()`

Rename a file or directory.

Note: This is similar to `renameat` in POSIX.

Inputs:

- <a href="#path_rename.old_fd" name="path_rename.old_fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>old_fd</strong></code>

  The working directory at which the resolution of the old path starts.

- <a href="#path_rename.old_path" name="path_rename.old_path"></a><code>const char \*<strong>old_path</strong></code> and <a href="#path_rename.old_path_len" name="path_rename.old_path_len"></a><code>\_\_wasi_size_t <strong>old_path_len</strong></code>

  The source path of the file or directory to rename.

- <a href="#path_rename.new_fd" name="path_rename.new_fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>new_fd</strong></code>

  The working directory at which the resolution of the new path starts.

- <a href="#path_rename.new_path" name="path_rename.new_path"></a><code>const char \*<strong>new_path</strong></code> and <a href="#path_rename.new_path_len" name="path_rename.new_path_len"></a><code>\_\_wasi_size_t <strong>new_path_len</strong></code>

  The destination path to which to rename the file or directory.

### <a href="#path_symlink" name="path_symlink"></a>`uvwasi_path_symlink()`

Create a symbolic link.

Note: This is similar to `symlinkat` in POSIX.

Inputs:

- <a href="#path_symlink.old_path" name="path_symlink.old_path"></a><code>const char \*<strong>old_path</strong></code> and <a href="#path_symlink.old_path_len" name="path_symlink.old_path_len"></a><code>\_\_wasi_size_t <strong>old_path_len</strong></code>

  The contents of the symbolic link.

- <a href="#path_symlink.fd" name="path_symlink.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_symlink.new_path" name="path_symlink.new_path"></a><code>const char \*<strong>new_path</strong></code> and <a href="#path_symlink.new_path_len" name="path_symlink.new_path_len"></a><code>\_\_wasi_size_t <strong>new_path_len</strong></code>

  The destination path at which to create the symbolic link.

### <a href="#path_unlink_file" name="path_unlink_file"></a>`uvwasi_path_unlink_file()`

Unlink a file.

Return [`UVWASI_EISDIR`](#errno.isdir) if the path refers to a directory.

Note: This is similar to `unlinkat(fd, path, 0)` in POSIX.

Inputs:

- <a href="#path_unlink_file.fd" name="path_unlink_file.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

  The working directory at which the resolution of the path starts.

- <a href="#path_unlink_file.path" name="path_unlink_file.path"></a><code>const char \*<strong>path</strong></code> and <a href="#path_unlink_file.path_len" name="path_unlink_file.path_len"></a><code>\_\_wasi_size_t <strong>path_len</strong></code>

  The path to a file to unlink.

### <a href="#poll_oneoff" name="poll_oneoff"></a>`uvwasi_poll_oneoff()`

Concurrently poll for the occurrence of a set of events.

Inputs:

- <a href="#poll_oneoff.in" name="poll_oneoff.in"></a><code>const [\_\_wasi_subscription_t](#subscription) \*<strong>in</strong></code>

  The events to which to subscribe.

- <a href="#poll_oneoff.out" name="poll_oneoff.out"></a><code>[\_\_wasi_event_t](#event) \*<strong>out</strong></code>

  The events that have occurred.

- <a href="#poll_oneoff.nsubscriptions" name="poll_oneoff.nsubscriptions"></a><code>\_\_wasi_size_t <strong>nsubscriptions</strong></code>

  Both the number of subscriptions and events.

Outputs:

- <a href="#poll_oneoff.nevents" name="poll_oneoff.nevents"></a><code>\_\_wasi_size_t <strong>nevents</strong></code>

  The number of events stored.

### <a href="#proc_exit" name="proc_exit"></a>`uvwasi_proc_exit()`

Terminate the process normally. An exit code of 0 indicates successful
termination of the program. The meanings of other values is dependent on
the environment.

Note: This is similar to `_Exit` in POSIX.

Inputs:

- <a href="#proc_exit.rval" name="proc_exit.rval"></a><code>[\_\_wasi_exitcode_t](#exitcode) <strong>rval</strong></code>

  The exit code returned by the process.

Does not return.

### <a href="#proc_raise" name="proc_raise"></a>`uvwasi_proc_raise()`

Send a signal to the process of the calling thread.

Note: This is similar to `raise` in POSIX.

Inputs:

- <a href="#proc_raise.sig" name="proc_raise.sig"></a><code>[\_\_wasi_signal_t](#signal) <strong>sig</strong></code>

  The signal condition to trigger.

### <a href="#random_get" name="random_get"></a>`uvwasi_random_get()`

Write high-quality random data into a buffer.

This function blocks when the implementation is unable to immediately
provide sufficient high-quality random data.

This function may execute slowly, so when large mounts of random
data are required, it's advisable to use this function to seed a
pseudo-random number generator, rather than to provide the
random data directly.

Inputs:

- <a href="#random_get.buf" name="random_get.buf"></a><code>void \*<strong>buf</strong></code> and <a href="#random_get.buf_len" name="random_get.buf_len"></a><code>\_\_wasi_size_t <strong>buf_len</strong></code>

  The buffer to fill with random data.

### <a href="#sched_yield" name="sched_yield"></a>`uvwasi_sched_yield()`

Temporarily yield execution of the calling thread.

Note: This is similar to `sched_yield` in POSIX.

### <a href="#sock_recv" name="sock_recv"></a>`uvwasi_sock_recv()`

Receive a message from a socket.

Note: This is similar to `recv` in POSIX, though it also supports reading
the data into multiple buffers in the manner of `readv`.

Inputs:

- <a href="#sock_recv.sock" name="sock_recv.sock"></a><code>[\_\_wasi_fd_t](#fd) <strong>sock</strong></code>

  The socket on which to receive data.

- <a href="#sock_recv.ri_data" name="sock_recv.ri_data"></a><code>const [\_\_wasi_iovec_t](#iovec) \*<strong>ri_data</strong></code> and <a href="#sock_recv.ri_data_len" name="sock_recv.ri_data_len"></a><code>\_\_wasi_size_t <strong>ri_data_len</strong></code>

  List of scatter/gather vectors to which to store data.

- <a href="#sock_recv.ri_flags" name="sock_recv.ri_flags"></a><code>[\_\_wasi_riflags_t](#riflags) <strong>ri_flags</strong></code>

  Message flags.

Outputs:

- <a href="#sock_recv.ro_datalen" name="sock_recv.ro_datalen"></a><code>\_\_wasi_size_t <strong>ro_datalen</strong></code>

  Number of bytes stored in [`ri_data`](#sock_recv.ri_data).

- <a href="#sock_recv.ro_flags" name="sock_recv.ro_flags"></a><code>[\_\_wasi_roflags_t](#roflags) <strong>ro_flags</strong></code>

  Message flags.

### <a href="#sock_send" name="sock_send"></a>`uvwasi_sock_send()`

Send a message on a socket.

Note: This is similar to `send` in POSIX, though it also supports writing
the data from multiple buffers in the manner of `writev`.

Inputs:

- <a href="#sock_send.sock" name="sock_send.sock"></a><code>[\_\_wasi_fd_t](#fd) <strong>sock</strong></code>

  The socket on which to send data.

- <a href="#sock_send.si_data" name="sock_send.si_data"></a><code>const [\_\_wasi_ciovec_t](#ciovec) \*<strong>si_data</strong></code> and <a href="#sock_send.si_data_len" name="sock_send.si_data_len"></a><code>\_\_wasi_size_t <strong>si_data_len</strong></code>

  List of scatter/gather vectors to which to retrieve data

- <a href="#sock_send.si_flags" name="sock_send.si_flags"></a><code>[\_\_wasi_siflags_t](#siflags) <strong>si_flags</strong></code>

  Message flags.

Outputs:

- <a href="#sock_send.so_datalen" name="sock_send.so_datalen"></a><code>\_\_wasi_size_t <strong>so_datalen</strong></code>

  Number of bytes transmitted.

### <a href="#sock_shutdown" name="sock_shutdown"></a>`uvwasi_sock_shutdown()`

Shut down socket send and receive channels.

Note: This is similar to `shutdown` in POSIX.

Inputs:

- <a href="#sock_shutdown.sock" name="sock_shutdown.sock"></a><code>[\_\_wasi_fd_t](#fd) <strong>sock</strong></code>

  The socket on which to shutdown channels.

- <a href="#sock_shutdown.how" name="sock_shutdown.how"></a><code>[\_\_wasi_sdflags_t](#sdflags) <strong>how</strong></code>

  Which channels on the socket to shut down.

## Types

### <a href="#advice" name="advice"></a>`uvwasi_advice_t` (`uint8_t`)

File or memory access pattern advisory information.

Used by [`uvwasi_fd_advise()`](#fd_advise).

Possible values:

- <a href="#advice.dontneed" name="advice.dontneed"></a>**`UVWASI_ADVICE_DONTNEED`**

  The application expects that it will not access the
  specified data in the near future.

- <a href="#advice.noreuse" name="advice.noreuse"></a>**`UVWASI_ADVICE_NOREUSE`**

  The application expects to access the specified data
  once and then not reuse it thereafter.

- <a href="#advice.normal" name="advice.normal"></a>**`UVWASI_ADVICE_NORMAL`**

  The application has no advice to give on its behavior
  with respect to the specified data.

- <a href="#advice.random" name="advice.random"></a>**`UVWASI_ADVICE_RANDOM`**

  The application expects to access the specified data
  in a random order.

- <a href="#advice.sequential" name="advice.sequential"></a>**`UVWASI_ADVICE_SEQUENTIAL`**

  The application expects to access the specified data
  sequentially from lower offsets to higher offsets.

- <a href="#advice.willneed" name="advice.willneed"></a>**`UVWASI_ADVICE_WILLNEED`**

  The application expects to access the specified data
  in the near future.

### <a href="#ciovec" name="ciovec"></a>`uvwasi_ciovec_t` (`struct`)

A region of memory for scatter/gather writes.

Used by [`uvwasi_fd_pwrite()`](#fd_pwrite), [`uvwasi_fd_write()`](#fd_write), and [`uvwasi_sock_send()`](#sock_send).

Members:

- <a href="#ciovec.buf" name="ciovec.buf"></a><code>const void \*<strong>buf</strong></code> and <a href="#ciovec.buf_len" name="ciovec.buf_len"></a><code>\_\_wasi_size_t <strong>buf_len</strong></code>

  The address and length of the buffer to be written.

### <a href="#clockid" name="clockid"></a>`uvwasi_clockid_t` (`uint32_t`)

Identifiers for clocks.

Used by [`uvwasi_subscription_t`](#subscription), [`uvwasi_clock_res_get()`](#clock_res_get), and [`uvwasi_clock_time_get()`](#clock_time_get).

Possible values:

- <a href="#clockid.monotonic" name="clockid.monotonic"></a>**`UVWASI_CLOCK_MONOTONIC`**

  The store-wide monotonic clock, which is defined as a
  clock measuring real time, whose value cannot be
  adjusted and which cannot have negative clock jumps.

  The epoch of this clock is undefined. The absolute
  time value of this clock therefore has no meaning.

- <a href="#clockid.process_cputime_id" name="clockid.process_cputime_id"></a>**`UVWASI_CLOCK_PROCESS_CPUTIME_ID`**

  The CPU-time clock associated with the current
  process.

- <a href="#clockid.realtime" name="clockid.realtime"></a>**`UVWASI_CLOCK_REALTIME`**

  The clock measuring real time. Time value
  zero corresponds with 1970-01-01T00:00:00Z.

- <a href="#clockid.thread_cputime_id" name="clockid.thread_cputime_id"></a>**`UVWASI_CLOCK_THREAD_CPUTIME_ID`**

  The CPU-time clock associated with the current thread.

### <a href="#device" name="device"></a>`uvwasi_device_t` (`uint64_t`)

Identifier for a device containing a file system. Can be used
in combination with [`uvwasi_inode_t`](#inode) to uniquely identify a file or
directory in the filesystem.

Used by [`uvwasi_filestat_t`](#filestat).

### <a href="#dircookie" name="dircookie"></a>`uvwasi_dircookie_t` (`uint64_t`)

A reference to the offset of a directory entry.

Used by [`uvwasi_dirent_t`](#dirent) and [`uvwasi_fd_readdir()`](#fd_readdir).

Special values:

- <a href="#dircookie.start" name="dircookie.start"></a>**`UVWASI_DIRCOOKIE_START`**

  Permanent reference to the first directory entry
  within a directory.

### <a href="#dirent" name="dirent"></a>`uvwasi_dirent_t` (`struct`)

A directory entry.

Members:

- <a href="#dirent.d_next" name="dirent.d_next"></a><code>[\_\_wasi_dircookie_t](#dircookie) <strong>d_next</strong></code>

  The offset of the next directory entry stored in this
  directory.

- <a href="#dirent.d_ino" name="dirent.d_ino"></a><code>[\_\_wasi_inode_t](#inode) <strong>d_ino</strong></code>

  The serial number of the file referred to by this
  directory entry.

- <a href="#dirent.d_namlen" name="dirent.d_namlen"></a><code>uint32_t <strong>d_namlen</strong></code>

  The length of the name of the directory entry.

- <a href="#dirent.d_type" name="dirent.d_type"></a><code>[\_\_wasi_filetype_t](#filetype) <strong>d_type</strong></code>

  The type of the file referred to by this directory
  entry.

### <a href="#errno" name="errno"></a>`uvwasi_errno_t` (`uint16_t`)

Error codes returned by functions.

Not all of these error codes are returned by the functions
provided by this API; some are used in higher-level library layers,
and others are provided merely for alignment with POSIX.

Used by [`uvwasi_event_t`](#event).

Possible values:

- <a href="#errno.success" name="errno.success"></a>**`UVWASI_ESUCCESS`**

  No error occurred. System call completed successfully.

- <a href="#errno.2big" name="errno.2big"></a>**`UVWASI_E2BIG`**

  Argument list too long.

- <a href="#errno.acces" name="errno.acces"></a>**`UVWASI_EACCES`**

  Permission denied.

- <a href="#errno.addrinuse" name="errno.addrinuse"></a>**`UVWASI_EADDRINUSE`**

  Address in use.

- <a href="#errno.addrnotavail" name="errno.addrnotavail"></a>**`UVWASI_EADDRNOTAVAIL`**

  Address not available.

- <a href="#errno.afnosupport" name="errno.afnosupport"></a>**`UVWASI_EAFNOSUPPORT`**

  Address family not supported.

- <a href="#errno.again" name="errno.again"></a>**`UVWASI_EAGAIN`**

  Resource unavailable, or operation would block.

- <a href="#errno.already" name="errno.already"></a>**`UVWASI_EALREADY`**

  Connection already in progress.

- <a href="#errno.badf" name="errno.badf"></a>**`UVWASI_EBADF`**

  Bad file descriptor.

- <a href="#errno.badmsg" name="errno.badmsg"></a>**`UVWASI_EBADMSG`**

  Bad message.

- <a href="#errno.busy" name="errno.busy"></a>**`UVWASI_EBUSY`**

  Device or resource busy.

- <a href="#errno.canceled" name="errno.canceled"></a>**`UVWASI_ECANCELED`**

  Operation canceled.

- <a href="#errno.child" name="errno.child"></a>**`UVWASI_ECHILD`**

  No child processes.

- <a href="#errno.connaborted" name="errno.connaborted"></a>**`UVWASI_ECONNABORTED`**

  Connection aborted.

- <a href="#errno.connrefused" name="errno.connrefused"></a>**`UVWASI_ECONNREFUSED`**

  Connection refused.

- <a href="#errno.connreset" name="errno.connreset"></a>**`UVWASI_ECONNRESET`**

  Connection reset.

- <a href="#errno.deadlk" name="errno.deadlk"></a>**`UVWASI_EDEADLK`**

  Resource deadlock would occur.

- <a href="#errno.destaddrreq" name="errno.destaddrreq"></a>**`UVWASI_EDESTADDRREQ`**

  Destination address required.

- <a href="#errno.dom" name="errno.dom"></a>**`UVWASI_EDOM`**

  Mathematics argument out of domain of function.

- <a href="#errno.dquot" name="errno.dquot"></a>**`UVWASI_EDQUOT`**

  Reserved.

- <a href="#errno.exist" name="errno.exist"></a>**`UVWASI_EEXIST`**

  File exists.

- <a href="#errno.fault" name="errno.fault"></a>**`UVWASI_EFAULT`**

  Bad address.

- <a href="#errno.fbig" name="errno.fbig"></a>**`UVWASI_EFBIG`**

  File too large.

- <a href="#errno.hostunreach" name="errno.hostunreach"></a>**`UVWASI_EHOSTUNREACH`**

  Host is unreachable.

- <a href="#errno.idrm" name="errno.idrm"></a>**`UVWASI_EIDRM`**

  Identifier removed.

- <a href="#errno.ilseq" name="errno.ilseq"></a>**`UVWASI_EILSEQ`**

  Illegal byte sequence.

- <a href="#errno.inprogress" name="errno.inprogress"></a>**`UVWASI_EINPROGRESS`**

  Operation in progress.

- <a href="#errno.intr" name="errno.intr"></a>**`UVWASI_EINTR`**

  Interrupted function.

- <a href="#errno.inval" name="errno.inval"></a>**`UVWASI_EINVAL`**

  Invalid argument.

- <a href="#errno.io" name="errno.io"></a>**`UVWASI_EIO`**

  I/O error.

- <a href="#errno.isconn" name="errno.isconn"></a>**`UVWASI_EISCONN`**

  Socket is connected.

- <a href="#errno.isdir" name="errno.isdir"></a>**`UVWASI_EISDIR`**

  Is a directory.

- <a href="#errno.loop" name="errno.loop"></a>**`UVWASI_ELOOP`**

  Too many levels of symbolic links.

- <a href="#errno.mfile" name="errno.mfile"></a>**`UVWASI_EMFILE`**

  File descriptor value too large.

- <a href="#errno.mlink" name="errno.mlink"></a>**`UVWASI_EMLINK`**

  Too many links.

- <a href="#errno.msgsize" name="errno.msgsize"></a>**`UVWASI_EMSGSIZE`**

  Message too large.

- <a href="#errno.multihop" name="errno.multihop"></a>**`UVWASI_EMULTIHOP`**

  Reserved.

- <a href="#errno.nametoolong" name="errno.nametoolong"></a>**`UVWASI_ENAMETOOLONG`**

  Filename too long.

- <a href="#errno.netdown" name="errno.netdown"></a>**`UVWASI_ENETDOWN`**

  Network is down.

- <a href="#errno.netreset" name="errno.netreset"></a>**`UVWASI_ENETRESET`**

  Connection aborted by network.

- <a href="#errno.netunreach" name="errno.netunreach"></a>**`UVWASI_ENETUNREACH`**

  Network unreachable.

- <a href="#errno.nfile" name="errno.nfile"></a>**`UVWASI_ENFILE`**

  Too many files open in system.

- <a href="#errno.nobufs" name="errno.nobufs"></a>**`UVWASI_ENOBUFS`**

  No buffer space available.

- <a href="#errno.nodev" name="errno.nodev"></a>**`UVWASI_ENODEV`**

  No such device.

- <a href="#errno.noent" name="errno.noent"></a>**`UVWASI_ENOENT`**

  No such file or directory.

- <a href="#errno.noexec" name="errno.noexec"></a>**`UVWASI_ENOEXEC`**

  Executable file format error.

- <a href="#errno.nolck" name="errno.nolck"></a>**`UVWASI_ENOLCK`**

  No locks available.

- <a href="#errno.nolink" name="errno.nolink"></a>**`UVWASI_ENOLINK`**

  Reserved.

- <a href="#errno.nomem" name="errno.nomem"></a>**`UVWASI_ENOMEM`**

  Not enough space.

- <a href="#errno.nomsg" name="errno.nomsg"></a>**`UVWASI_ENOMSG`**

  No message of the desired type.

- <a href="#errno.noprotoopt" name="errno.noprotoopt"></a>**`UVWASI_ENOPROTOOPT`**

  Protocol not available.

- <a href="#errno.nospc" name="errno.nospc"></a>**`UVWASI_ENOSPC`**

  No space left on device.

- <a href="#errno.nosys" name="errno.nosys"></a>**`UVWASI_ENOSYS`**

  Function not supported.

- <a href="#errno.notconn" name="errno.notconn"></a>**`UVWASI_ENOTCONN`**

  The socket is not connected.

- <a href="#errno.notdir" name="errno.notdir"></a>**`UVWASI_ENOTDIR`**

  Not a directory or a symbolic link to a directory.

- <a href="#errno.notempty" name="errno.notempty"></a>**`UVWASI_ENOTEMPTY`**

  Directory not empty.

- <a href="#errno.notrecoverable" name="errno.notrecoverable"></a>**`UVWASI_ENOTRECOVERABLE`**

  State not recoverable.

- <a href="#errno.notsock" name="errno.notsock"></a>**`UVWASI_ENOTSOCK`**

  Not a socket.

- <a href="#errno.notsup" name="errno.notsup"></a>**`UVWASI_ENOTSUP`**

  Not supported, or operation not supported on socket.

- <a href="#errno.notty" name="errno.notty"></a>**`UVWASI_ENOTTY`**

  Inappropriate I/O control operation.

- <a href="#errno.nxio" name="errno.nxio"></a>**`UVWASI_ENXIO`**

  No such device or address.

- <a href="#errno.overflow" name="errno.overflow"></a>**`UVWASI_EOVERFLOW`**

  Value too large to be stored in data type.

- <a href="#errno.ownerdead" name="errno.ownerdead"></a>**`UVWASI_EOWNERDEAD`**

  Previous owner died.

- <a href="#errno.perm" name="errno.perm"></a>**`UVWASI_EPERM`**

  Operation not permitted.

- <a href="#errno.pipe" name="errno.pipe"></a>**`UVWASI_EPIPE`**

  Broken pipe.

- <a href="#errno.proto" name="errno.proto"></a>**`UVWASI_EPROTO`**

  Protocol error.

- <a href="#errno.protonosupport" name="errno.protonosupport"></a>**`UVWASI_EPROTONOSUPPORT`**

  Protocol not supported.

- <a href="#errno.prototype" name="errno.prototype"></a>**`UVWASI_EPROTOTYPE`**

  Protocol wrong type for socket.

- <a href="#errno.range" name="errno.range"></a>**`UVWASI_ERANGE`**

  Result too large.

- <a href="#errno.rofs" name="errno.rofs"></a>**`UVWASI_EROFS`**

  Read-only file system.

- <a href="#errno.spipe" name="errno.spipe"></a>**`UVWASI_ESPIPE`**

  Invalid seek.

- <a href="#errno.srch" name="errno.srch"></a>**`UVWASI_ESRCH`**

  No such process.

- <a href="#errno.stale" name="errno.stale"></a>**`UVWASI_ESTALE`**

  Reserved.

- <a href="#errno.timedout" name="errno.timedout"></a>**`UVWASI_ETIMEDOUT`**

  Connection timed out.

- <a href="#errno.txtbsy" name="errno.txtbsy"></a>**`UVWASI_ETXTBSY`**

  Text file busy.

- <a href="#errno.xdev" name="errno.xdev"></a>**`UVWASI_EXDEV`**

  Cross-device link.

- <a href="#errno.notcapable" name="errno.notcapable"></a>**`UVWASI_ENOTCAPABLE`**

  Extension: Capabilities insufficient.

### <a href="#event" name="event"></a>`uvwasi_event_t` (`struct`)

An event that occurred.

Used by [`uvwasi_poll_oneoff()`](#poll_oneoff).

Members:

- <a href="#event.userdata" name="event.userdata"></a><code>[\_\_wasi_userdata_t](#userdata) <strong>userdata</strong></code>

  User-provided value that got attached to
  [`uvwasi_subscription_t::userdata`](#subscription.userdata).

- <a href="#event.error" name="event.error"></a><code>[\_\_wasi_errno_t](#errno) <strong>error</strong></code>

  If non-zero, an error that occurred while processing
  the subscription request.

- <a href="#event.type" name="event.type"></a><code>[\_\_wasi_eventtype_t](#eventtype) <strong>type</strong></code>

  The type of the event that occurred.

- When `type` is [`UVWASI_EVENTTYPE_FD_READ`](#eventtype.fd_read) or [`UVWASI_EVENTTYPE_FD_WRITE`](#eventtype.fd_write):
  - <a href="#event.u.fd_readwrite" name="event.u.fd_readwrite"></a>**`u.fd_readwrite`**
    - <a href="#event.u.fd_readwrite.nbytes" name="event.u.fd_readwrite.nbytes"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>nbytes</strong></code>

      The number of bytes available for reading or writing.

    - <a href="#event.u.fd_readwrite.flags" name="event.u.fd_readwrite.flags"></a><code>[\_\_wasi_eventrwflags_t](#eventrwflags) <strong>flags</strong></code>

      The state of the file descriptor.

### <a href="#eventrwflags" name="eventrwflags"></a>`uvwasi_eventrwflags_t` (`uint16_t` bitfield)

The state of the file descriptor subscribed to with
[`UVWASI_EVENTTYPE_FD_READ`](#eventtype.fd_read) or [`UVWASI_EVENTTYPE_FD_WRITE`](#eventtype.fd_write).

Used by [`uvwasi_event_t`](#event).

Possible values:

- <a href="#eventrwflags.hangup" name="eventrwflags.hangup"></a>**`UVWASI_EVENT_FD_READWRITE_HANGUP`**

  The peer of this socket has closed or disconnected.

### <a href="#eventtype" name="eventtype"></a>`uvwasi_eventtype_t` (`uint8_t`)

Type of a subscription to an event or its occurrence.

Used by [`uvwasi_event_t`](#event) and [`uvwasi_subscription_t`](#subscription).

Possible values:

- <a href="#eventtype.u.clock" name="eventtype.u.clock"></a>**`UVWASI_EVENTTYPE_CLOCK`**

  The time value of clock [`uvwasi_subscription_t::u.clock.clock_id`](#subscription.u.clock.clock_id)
  has reached timestamp [`uvwasi_subscription_t::u.clock.timeout`](#subscription.u.clock.timeout).

- <a href="#eventtype.fd_read" name="eventtype.fd_read"></a>**`UVWASI_EVENTTYPE_FD_READ`**

  File descriptor [`uvwasi_subscription_t::u.fd_readwrite.fd`](#subscription.u.fd_readwrite.fd) has
  data available for reading. This event always triggers
  for regular files.

- <a href="#eventtype.fd_write" name="eventtype.fd_write"></a>**`UVWASI_EVENTTYPE_FD_WRITE`**

  File descriptor [`uvwasi_subscription_t::u.fd_readwrite.fd`](#subscription.u.fd_readwrite.fd) has
  capacity available for writing. This event always
  triggers for regular files.

### <a href="#exitcode" name="exitcode"></a>`uvwasi_exitcode_t` (`uint32_t`)

Exit code generated by a process when exiting.

Used by [`uvwasi_proc_exit()`](#proc_exit).

### <a href="#fd" name="fd"></a>`uvwasi_fd_t` (`uint32_t`)

A file descriptor number.

Used by many functions in this API.

As in POSIX, three file descriptor numbers are provided to instances
on startup -- 0, 1, and 2, (a.k.a. `STDIN_FILENO`, `STDOUT_FILENO`,
and `STDERR_FILENO`).

Other than these, WASI implementations are not required to allocate
new file descriptors in ascending order.

### <a href="#fdflags" name="fdflags"></a>`uvwasi_fdflags_t` (`uint16_t` bitfield)

File descriptor flags.

Used by [`uvwasi_fdstat_t`](#fdstat), [`uvwasi_fd_fdstat_set_flags()`](#fd_fdstat_set_flags), and [`uvwasi_path_open()`](#path_open).

Possible values:

- <a href="#fdflags.append" name="fdflags.append"></a>**`UVWASI_FDFLAG_APPEND`**

  Append mode: Data written to the file is always
  appended to the file's end.

- <a href="#fdflags.dsync" name="fdflags.dsync"></a>**`UVWASI_FDFLAG_DSYNC`**

  Write according to synchronized I/O data integrity
  completion. Only the data stored in the file is
  synchronized.

- <a href="#fdflags.nonblock" name="fdflags.nonblock"></a>**`UVWASI_FDFLAG_NONBLOCK`**

  Non-blocking mode.

- <a href="#fdflags.rsync" name="fdflags.rsync"></a>**`UVWASI_FDFLAG_RSYNC`**

  Synchronized read I/O operations.

- <a href="#fdflags.sync" name="fdflags.sync"></a>**`UVWASI_FDFLAG_SYNC`**

  Write according to synchronized I/O file integrity completion.
  In addition to synchronizing the data stored in the file, the
  implementation may also synchronously update the file's metadata.

### <a href="#fdstat" name="fdstat"></a>`uvwasi_fdstat_t` (`struct`)

File descriptor attributes.

Used by [`uvwasi_fd_fdstat_get()`](#fd_fdstat_get).

Members:

- <a href="#fdstat.fs_filetype" name="fdstat.fs_filetype"></a><code>[\_\_wasi_filetype_t](#filetype) <strong>fs_filetype</strong></code>

  File type.

- <a href="#fdstat.fs_flags" name="fdstat.fs_flags"></a><code>[\_\_wasi_fdflags_t](#fdflags) <strong>fs_flags</strong></code>

  File descriptor flags.

- <a href="#fdstat.fs_rights_base" name="fdstat.fs_rights_base"></a><code>[\_\_wasi_rights_t](#rights) <strong>fs_rights_base</strong></code>

  Rights that apply to this file descriptor.

- <a href="#fdstat.fs_rights_inheriting" name="fdstat.fs_rights_inheriting"></a><code>[\_\_wasi_rights_t](#rights) <strong>fs_rights_inheriting</strong></code>

  Maximum set of rights that may be installed on new
  file descriptors that are created through this file
  descriptor, e.g., through [`uvwasi_path_open()`](#path_open).

### <a href="#filedelta" name="filedelta"></a>`uvwasi_filedelta_t` (`int64_t`)

Relative offset within a file.

Used by [`uvwasi_fd_seek()`](#fd_seek).

### <a href="#filesize" name="filesize"></a>`uvwasi_filesize_t` (`uint64_t`)

Non-negative file size or length of a region within a file.

Used by [`uvwasi_event_t`](#event), [`uvwasi_filestat_t`](#filestat), [`uvwasi_fd_pread()`](#fd_pread), [`uvwasi_fd_pwrite()`](#fd_pwrite), [`uvwasi_fd_seek()`](#fd_seek), [`uvwasi_path_tell()`](#path_tell), [`uvwasi_fd_advise()`](#fd_advise), [`uvwasi_fd_allocate()`](#fd_allocate), and [`uvwasi_fd_filestat_set_size()`](#fd_filestat_set_size).

### <a href="#filestat" name="filestat"></a>`uvwasi_filestat_t` (`struct`)

File attributes.

Used by [`uvwasi_fd_filestat_get()`](#fd_filestat_get) and [`uvwasi_path_filestat_get()`](#path_filestat_get).

Members:

- <a href="#filestat.st_dev" name="filestat.st_dev"></a><code>[\_\_wasi_device_t](#device) <strong>st_dev</strong></code>

  Device ID of device containing the file.

- <a href="#filestat.st_ino" name="filestat.st_ino"></a><code>[\_\_wasi_inode_t](#inode) <strong>st_ino</strong></code>

  File serial number.

- <a href="#filestat.st_filetype" name="filestat.st_filetype"></a><code>[\_\_wasi_filetype_t](#filetype) <strong>st_filetype</strong></code>

  File type.

- <a href="#filestat.st_nlink" name="filestat.st_nlink"></a><code>[\_\_wasi_linkcount_t](#linkcount) <strong>st_nlink</strong></code>

  Number of hard links to the file.

- <a href="#filestat.st_size" name="filestat.st_size"></a><code>[\_\_wasi_filesize_t](#filesize) <strong>st_size</strong></code>

  For regular files, the file size in bytes. For
  symbolic links, the length in bytes of the pathname
  contained in the symbolic link.

- <a href="#filestat.st_atim" name="filestat.st_atim"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>st_atim</strong></code>

  Last data access timestamp.

- <a href="#filestat.st_mtim" name="filestat.st_mtim"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>st_mtim</strong></code>

  Last data modification timestamp.

- <a href="#filestat.st_ctim" name="filestat.st_ctim"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>st_ctim</strong></code>

  Last file status change timestamp.

### <a href="#filetype" name="filetype"></a>`uvwasi_filetype_t` (`uint8_t`)

The type of a file descriptor or file.

Used by [`uvwasi_dirent_t`](#dirent), [`uvwasi_fdstat_t`](#fdstat), and [`uvwasi_filestat_t`](#filestat).

Possible values:

- <a href="#filetype.unknown" name="filetype.unknown"></a>**`UVWASI_FILETYPE_UNKNOWN`**

  The type of the file descriptor or file is unknown or
  is different from any of the other types specified.

- <a href="#filetype.block_device" name="filetype.block_device"></a>**`UVWASI_FILETYPE_BLOCK_DEVICE`**

  The file descriptor or file refers to a block device
  inode.

- <a href="#filetype.character_device" name="filetype.character_device"></a>**`UVWASI_FILETYPE_CHARACTER_DEVICE`**

  The file descriptor or file refers to a character
  device inode.

- <a href="#filetype.directory" name="filetype.directory"></a>**`UVWASI_FILETYPE_DIRECTORY`**

  The file descriptor or file refers to a directory
  inode.

- <a href="#filetype.regular_file" name="filetype.regular_file"></a>**`UVWASI_FILETYPE_REGULAR_FILE`**

  The file descriptor or file refers to a regular file
  inode.

- <a href="#filetype.socket_dgram" name="filetype.socket_dgram"></a>**`UVWASI_FILETYPE_SOCKET_DGRAM`**

  The file descriptor or file refers to a datagram
  socket.

- <a href="#filetype.socket_stream" name="filetype.socket_stream"></a>**`UVWASI_FILETYPE_SOCKET_STREAM`**

  The file descriptor or file refers to a byte-stream
  socket.

- <a href="#filetype.symbolic_link" name="filetype.symbolic_link"></a>**`UVWASI_FILETYPE_SYMBOLIC_LINK`**

  The file refers to a symbolic link inode.

### <a href="#fstflags" name="fstflags"></a>`uvwasi_fstflags_t` (`uint16_t` bitfield)

Which file time attributes to adjust.

Used by [`uvwasi_fd_filestat_set_times()`](#fd_filestat_set_times) and [`uvwasi_path_filestat_set_times()`](#path_filestat_set_times).

Possible values:

- <a href="#fstflags.atim" name="fstflags.atim"></a>**`UVWASI_FILESTAT_SET_ATIM`**

  Adjust the last data access timestamp to the value
  stored in [`uvwasi_filestat_t::st_atim`](#filestat.st_atim).

- <a href="#fstflags.atim_now" name="fstflags.atim_now"></a>**`UVWASI_FILESTAT_SET_ATIM_NOW`**

  Adjust the last data access timestamp to the time
  of clock [`UVWASI_CLOCK_REALTIME`](#clockid.realtime).

- <a href="#fstflags.mtim" name="fstflags.mtim"></a>**`UVWASI_FILESTAT_SET_MTIM`**

  Adjust the last data modification timestamp to the
  value stored in [`uvwasi_filestat_t::st_mtim`](#filestat.st_mtim).

- <a href="#fstflags.mtim_now" name="fstflags.mtim_now"></a>**`UVWASI_FILESTAT_SET_MTIM_NOW`**

  Adjust the last data modification timestamp to the
  time of clock [`UVWASI_CLOCK_REALTIME`](#clockid.realtime).

### <a href="#inode" name="inode"></a>`uvwasi_inode_t` (`uint64_t`)

File serial number that is unique within its file system.

Used by [`uvwasi_dirent_t`](#dirent) and [`uvwasi_filestat_t`](#filestat).

### <a href="#iovec" name="iovec"></a>`uvwasi_iovec_t` (`struct`)

A region of memory for scatter/gather reads.

Used by [`uvwasi_fd_pread()`](#fd_pread), [`uvwasi_fd_read()`](#fd_read), and [`uvwasi_sock_recv()`](#sock_recv).

Members:

- <a href="#iovec.buf" name="iovec.buf"></a><code>void \*<strong>buf</strong></code> and <a href="#iovec.buf_len" name="iovec.buf_len"></a><code>\_\_wasi_size_t <strong>buf_len</strong></code>

  The address and length of the buffer to be filled.

### <a href="#linkcount" name="linkcount"></a>`uvwasi_linkcount_t` (`uint64_t`)

Number of hard links to an inode.

Used by [`uvwasi_filestat_t`](#filestat).

### <a href="#lookupflags" name="lookupflags"></a>`uvwasi_lookupflags_t` (`uint32_t` bitfield)

Flags determining the method of how paths are resolved.

Used by [`uvwasi_path_filestat_get()`](#path_filestat_get), [`uvwasi_path_filestat_set_times()`](#path_filestat_set_times), [`uvwasi_path_link()`](#path_link), and [`uvwasi_path_open()`](#path_open).

Possible values:

- <a href="#lookupflags.symlink_follow" name="lookupflags.symlink_follow"></a>**`UVWASI_LOOKUP_SYMLINK_FOLLOW`**

  As long as the resolved path corresponds to a symbolic
  link, it is expanded.

### <a href="#oflags" name="oflags"></a>`uvwasi_oflags_t` (`uint16_t` bitfield)

Open flags used by [`uvwasi_path_open()`](#path_open).

Used by [`uvwasi_path_open()`](#path_open).

Possible values:

- <a href="#oflags.creat" name="oflags.creat"></a>**`UVWASI_O_CREAT`**

  Create file if it does not exist.

- <a href="#oflags.directory" name="oflags.directory"></a>**`UVWASI_O_DIRECTORY`**

  Fail if not a directory.

- <a href="#oflags.excl" name="oflags.excl"></a>**`UVWASI_O_EXCL`**

  Fail if file already exists.

- <a href="#oflags.trunc" name="oflags.trunc"></a>**`UVWASI_O_TRUNC`**

  Truncate file to size 0.

### <a href="#riflags" name="riflags"></a>`uvwasi_riflags_t` (`uint16_t` bitfield)

Flags provided to [`uvwasi_sock_recv()`](#sock_recv).

Used by [`uvwasi_sock_recv()`](#sock_recv).

Possible values:

- <a href="#riflags.peek" name="riflags.peek"></a>**`UVWASI_SOCK_RECV_PEEK`**

  Returns the message without removing it from the
  socket's receive queue.

- <a href="#riflags.waitall" name="riflags.waitall"></a>**`UVWASI_SOCK_RECV_WAITALL`**

  On byte-stream sockets, block until the full amount
  of data can be returned.

### <a href="#rights" name="rights"></a>`uvwasi_rights_t` (`uint64_t` bitfield)

File descriptor rights, determining which actions may be
performed.

Used by [`uvwasi_fdstat_t`](#fdstat), [`uvwasi_fd_fdstat_set_rights()`](#fd_fdstat_set_rights), and [`uvwasi_path_open()`](#path_open).

Possible values:

- <a href="#rights.fd_datasync" name="rights.fd_datasync"></a>**`UVWASI_RIGHT_FD_DATASYNC`**

  The right to invoke [`uvwasi_fd_datasync()`](#fd_datasync).

  If [`UVWASI_RIGHT_PATH_OPEN`](#rights.path_open) is set, includes the right to
  invoke [`uvwasi_path_open()`](#path_open) with [`UVWASI_FDFLAG_DSYNC`](#fdflags.dsync).

- <a href="#rights.fd_read" name="rights.fd_read"></a>**`UVWASI_RIGHT_FD_READ`**

  The right to invoke [`uvwasi_fd_read()`](#fd_read) and [`uvwasi_sock_recv()`](#sock_recv).

  If [`UVWASI_RIGHT_FD_SEEK`](#rights.fd_seek) is set, includes the right to invoke
  [`uvwasi_fd_pread()`](#fd_pread).

- <a href="#rights.fd_seek" name="rights.fd_seek"></a>**`UVWASI_RIGHT_FD_SEEK`**

  The right to invoke [`uvwasi_fd_seek()`](#fd_seek). This flag implies
  [`UVWASI_RIGHT_FD_TELL`](#rights.fd_tell).

- <a href="#rights.fd_fdstat_set_flags" name="rights.fd_fdstat_set_flags"></a>**`UVWASI_RIGHT_FD_FDSTAT_SET_FLAGS`**

  The right to invoke [`uvwasi_fd_fdstat_set_flags()`](#fd_fdstat_set_flags).

- <a href="#rights.fd_sync" name="rights.fd_sync"></a>**`UVWASI_RIGHT_FD_SYNC`**

  The right to invoke [`uvwasi_fd_sync()`](#fd_sync).

  If [`UVWASI_RIGHT_PATH_OPEN`](#rights.path_open) is set, includes the right to
  invoke [`uvwasi_path_open()`](#path_open) with [`UVWASI_FDFLAG_RSYNC`](#fdflags.rsync) and
  [`UVWASI_FDFLAG_DSYNC`](#fdflags.dsync).

- <a href="#rights.fd_tell" name="rights.fd_tell"></a>**`UVWASI_RIGHT_FD_TELL`**

  The right to invoke [`uvwasi_fd_seek()`](#fd_seek) in such a way that the
  file offset remains unaltered (i.e., [`UVWASI_WHENCE_CUR`](#whence.cur) with
  offset zero), or to invoke [`uvwasi_fd_tell()`](#fd_tell).

- <a href="#rights.fd_write" name="rights.fd_write"></a>**`UVWASI_RIGHT_FD_WRITE`**

  The right to invoke [`uvwasi_fd_write()`](#fd_write) and [`uvwasi_sock_send()`](#sock_send).

  If [`UVWASI_RIGHT_FD_SEEK`](#rights.fd_seek) is set, includes the right to
  invoke [`uvwasi_fd_pwrite()`](#fd_pwrite).

- <a href="#rights.fd_advise" name="rights.fd_advise"></a>**`UVWASI_RIGHT_FD_ADVISE`**

  The right to invoke [`uvwasi_fd_advise()`](#fd_advise).

- <a href="#rights.fd_allocate" name="rights.fd_allocate"></a>**`UVWASI_RIGHT_FD_ALLOCATE`**

  The right to invoke [`uvwasi_fd_allocate()`](#fd_allocate).

- <a href="#rights.path_create_directory" name="rights.path_create_directory"></a>**`UVWASI_RIGHT_PATH_CREATE_DIRECTORY`**

  The right to invoke [`uvwasi_path_create_directory()`](#path_create_directory).

- <a href="#rights.path_create_file" name="rights.path_create_file"></a>**`UVWASI_RIGHT_PATH_CREATE_FILE`**

  If [`UVWASI_RIGHT_PATH_OPEN`](#rights.path_open) is set, the right to invoke
  [`uvwasi_path_open()`](#path_open) with [`UVWASI_O_CREAT`](#oflags.creat).

- <a href="#rights.path_link_source" name="rights.path_link_source"></a>**`UVWASI_RIGHT_PATH_LINK_SOURCE`**

  The right to invoke [`uvwasi_path_link()`](#path_link) with the file
  descriptor as the source directory.

- <a href="#rights.path_link_target" name="rights.path_link_target"></a>**`UVWASI_RIGHT_PATH_LINK_TARGET`**

  The right to invoke [`uvwasi_path_link()`](#path_link) with the file
  descriptor as the target directory.

- <a href="#rights.path_open" name="rights.path_open"></a>**`UVWASI_RIGHT_PATH_OPEN`**

  The right to invoke [`uvwasi_path_open()`](#path_open).

- <a href="#rights.fd_readdir" name="rights.fd_readdir"></a>**`UVWASI_RIGHT_FD_READDIR`**

  The right to invoke [`uvwasi_fd_readdir()`](#fd_readdir).

- <a href="#rights.path_readlink" name="rights.path_readlink"></a>**`UVWASI_RIGHT_PATH_READLINK`**

  The right to invoke [`uvwasi_path_readlink()`](#path_readlink).

- <a href="#rights.path_rename_source" name="rights.path_rename_source"></a>**`UVWASI_RIGHT_PATH_RENAME_SOURCE`**

  The right to invoke [`uvwasi_path_rename()`](#path_rename) with the file
  descriptor as the source directory.

- <a href="#rights.path_rename_target" name="rights.path_rename_target"></a>**`UVWASI_RIGHT_PATH_RENAME_TARGET`**

  The right to invoke [`uvwasi_path_rename()`](#path_rename) with the file
  descriptor as the target directory.

- <a href="#rights.path_filestat_get" name="rights.path_filestat_get"></a>**`UVWASI_RIGHT_PATH_FILESTAT_GET`**

  The right to invoke [`uvwasi_path_filestat_get()`](#path_filestat_get).

- <a href="#rights.path_filestat_set_size" name="rights.path_filestat_set_size"></a>**`UVWASI_RIGHT_PATH_FILESTAT_SET_SIZE`**

  The right to change a file's size (there is no `uvwasi_path_filestat_set_size()`).

  If [`UVWASI_RIGHT_PATH_OPEN`](#rights.path_open) is set, includes the right to
  invoke [`uvwasi_path_open()`](#path_open) with [`UVWASI_O_TRUNC`](#oflags.trunc).

- <a href="#rights.path_filestat_set_times" name="rights.path_filestat_set_times"></a>**`UVWASI_RIGHT_PATH_FILESTAT_SET_TIMES`**

  The right to invoke [`uvwasi_path_filestat_set_times()`](#path_filestat_set_times).

- <a href="#rights.fd_filestat_get" name="rights.fd_filestat_get"></a>**`UVWASI_RIGHT_FD_FILESTAT_GET`**

  The right to invoke [`uvwasi_fd_filestat_get()`](#fd_filestat_get).

- <a href="#rights.fd_filestat_set_size" name="rights.fd_filestat_set_size"></a>**`UVWASI_RIGHT_FD_FILESTAT_SET_SIZE`**

  The right to invoke [`uvwasi_fd_filestat_set_size()`](#fd_filestat_set_size).

- <a href="#rights.fd_filestat_set_times" name="rights.fd_filestat_set_times"></a>**`UVWASI_RIGHT_FD_FILESTAT_SET_TIMES`**

  The right to invoke [`uvwasi_fd_filestat_set_times()`](#fd_filestat_set_times).

- <a href="#rights.path_symlink" name="rights.path_symlink"></a>**`UVWASI_RIGHT_PATH_SYMLINK`**

  The right to invoke [`uvwasi_path_symlink()`](#path_symlink).

- <a href="#rights.path_unlink_file" name="rights.path_unlink_file"></a>**`UVWASI_RIGHT_PATH_UNLINK_FILE`**

  The right to invoke [`uvwasi_path_unlink_file()`](#path_unlink_file).

- <a href="#rights.path_remove_directory" name="rights.path_remove_directory"></a>**`UVWASI_RIGHT_PATH_REMOVE_DIRECTORY`**

  The right to invoke [`uvwasi_path_remove_directory()`](#path_remove_directory).

- <a href="#rights.poll_fd_readwrite" name="rights.poll_fd_readwrite"></a>**`UVWASI_RIGHT_POLL_FD_READWRITE`**

  If [`UVWASI_RIGHT_FD_READ`](#rights.fd_read) is set, includes the right to
  invoke [`uvwasi_poll_oneoff()`](#poll_oneoff) to subscribe to [`UVWASI_EVENTTYPE_FD_READ`](#eventtype.fd_read).

  If [`UVWASI_RIGHT_FD_WRITE`](#rights.fd_write) is set, includes the right to
  invoke [`uvwasi_poll_oneoff()`](#poll_oneoff) to subscribe to [`UVWASI_EVENTTYPE_FD_WRITE`](#eventtype.fd_write).

- <a href="#rights.sock_shutdown" name="rights.sock_shutdown"></a>**`UVWASI_RIGHT_SOCK_SHUTDOWN`**

  The right to invoke [`uvwasi_sock_shutdown()`](#sock_shutdown).

### <a href="#roflags" name="roflags"></a>`uvwasi_roflags_t` (`uint16_t` bitfield)

Flags returned by [`uvwasi_sock_recv()`](#sock_recv).

Used by [`uvwasi_sock_recv()`](#sock_recv).

Possible values:

- <a href="#roflags.data_truncated" name="roflags.data_truncated"></a>**`UVWASI_SOCK_RECV_DATA_TRUNCATED`**

  Returned by [`uvwasi_sock_recv()`](#sock_recv): Message data has been
  truncated.

### <a href="#sdflags" name="sdflags"></a>`uvwasi_sdflags_t` (`uint8_t` bitfield)

Which channels on a socket to shut down.

Used by [`uvwasi_sock_shutdown()`](#sock_shutdown).

Possible values:

- <a href="#sdflags.rd" name="sdflags.rd"></a>**`UVWASI_SHUT_RD`**

  Disables further receive operations.

- <a href="#sdflags.wr" name="sdflags.wr"></a>**`UVWASI_SHUT_WR`**

  Disables further send operations.

### <a href="#siflags" name="siflags"></a>`uvwasi_siflags_t` (`uint16_t` bitfield)

Flags provided to [`uvwasi_sock_send()`](#sock_send). As there are currently no flags
defined, it must be set to zero.

Used by [`uvwasi_sock_send()`](#sock_send).

### <a href="#signal" name="signal"></a>`uvwasi_signal_t` (`uint8_t`)

Signal condition.

Used by [`uvwasi_proc_raise()`](#proc_raise).

Possible values:

- <a href="#signal.abrt" name="signal.abrt"></a>**`UVWASI_SIGABRT`**

  Process abort signal.

  Action: Terminates the process.

- <a href="#signal.alrm" name="signal.alrm"></a>**`UVWASI_SIGALRM`**

  Alarm clock.

  Action: Terminates the process.

- <a href="#signal.bus" name="signal.bus"></a>**`UVWASI_SIGBUS`**

  Access to an undefined portion of a memory object.

  Action: Terminates the process.

- <a href="#signal.chld" name="signal.chld"></a>**`UVWASI_SIGCHLD`**

  Child process terminated, stopped, or continued.

  Action: Ignored.

- <a href="#signal.cont" name="signal.cont"></a>**`UVWASI_SIGCONT`**

  Continue executing, if stopped.

  Action: Continues executing, if stopped.

- <a href="#signal.fpe" name="signal.fpe"></a>**`UVWASI_SIGFPE`**

  Erroneous arithmetic operation.

  Action: Terminates the process.

- <a href="#signal.hup" name="signal.hup"></a>**`UVWASI_SIGHUP`**

  Hangup.

  Action: Terminates the process.

- <a href="#signal.ill" name="signal.ill"></a>**`UVWASI_SIGILL`**

  Illegal instruction.

  Action: Terminates the process.

- <a href="#signal.int" name="signal.int"></a>**`UVWASI_SIGINT`**

  Terminate interrupt signal.

  Action: Terminates the process.

- <a href="#signal.kill" name="signal.kill"></a>**`UVWASI_SIGKILL`**

  Kill.

  Action: Terminates the process.

- <a href="#signal.pipe" name="signal.pipe"></a>**`UVWASI_SIGPIPE`**

  Write on a pipe with no one to read it.

  Action: Ignored.

- <a href="#signal.quit" name="signal.quit"></a>**`UVWASI_SIGQUIT`**

  Terminal quit signal.

  Action: Terminates the process.

- <a href="#signal.segv" name="signal.segv"></a>**`UVWASI_SIGSEGV`**

  Invalid memory reference.

  Action: Terminates the process.

- <a href="#signal.stop" name="signal.stop"></a>**`UVWASI_SIGSTOP`**

  Stop executing.

  Action: Stops executing.

- <a href="#signal.sys" name="signal.sys"></a>**`UVWASI_SIGSYS`**

  Bad system call.

  Action: Terminates the process.

- <a href="#signal.term" name="signal.term"></a>**`UVWASI_SIGTERM`**

  Termination signal.

  Action: Terminates the process.

- <a href="#signal.trap" name="signal.trap"></a>**`UVWASI_SIGTRAP`**

  Trace/breakpoint trap.

  Action: Terminates the process.

- <a href="#signal.tstp" name="signal.tstp"></a>**`UVWASI_SIGTSTP`**

  Terminal stop signal.

  Action: Stops executing.

- <a href="#signal.ttin" name="signal.ttin"></a>**`UVWASI_SIGTTIN`**

  Background process attempting read.

  Action: Stops executing.

- <a href="#signal.ttou" name="signal.ttou"></a>**`UVWASI_SIGTTOU`**

  Background process attempting write.

  Action: Stops executing.

- <a href="#signal.urg" name="signal.urg"></a>**`UVWASI_SIGURG`**

  High bandwidth data is available at a socket.

  Action: Ignored.

- <a href="#signal.usr1" name="signal.usr1"></a>**`UVWASI_SIGUSR1`**

  User-defined signal 1.

  Action: Terminates the process.

- <a href="#signal.usr2" name="signal.usr2"></a>**`UVWASI_SIGUSR2`**

  User-defined signal 2.

  Action: Terminates the process.

- <a href="#signal.vtalrm" name="signal.vtalrm"></a>**`UVWASI_SIGVTALRM`**

  Virtual timer expired.

  Action: Terminates the process.

- <a href="#signal.xcpu" name="signal.xcpu"></a>**`UVWASI_SIGXCPU`**

  CPU time limit exceeded.

  Action: Terminates the process.

- <a href="#signal.xfsz" name="signal.xfsz"></a>**`UVWASI_SIGXFSZ`**

  File size limit exceeded.

  Action: Terminates the process.

### <a href="#subclockflags" name="subclockflags"></a>`uvwasi_subclockflags_t` (`uint16_t` bitfield)

Flags determining how to interpret the timestamp provided in
[`uvwasi_subscription_t::u.clock.timeout`](#subscription.u.clock.timeout).

Used by [`uvwasi_subscription_t`](#subscription).

Possible values:

- <a href="#subclockflags.abstime" name="subclockflags.abstime"></a>**`UVWASI_SUBSCRIPTION_CLOCK_ABSTIME`**

  If set, treat the timestamp provided in
  [`uvwasi_subscription_t::u.clock.timeout`](#subscription.u.clock.timeout) as an absolute timestamp
  of clock [`uvwasi_subscription_t::u.clock.clock_id`](#subscription.u.clock.clock_id).

  If clear, treat the timestamp provided in
  [`uvwasi_subscription_t::u.clock.timeout`](#subscription.u.clock.timeout) relative to the current
  time value of clock [`uvwasi_subscription_t::u.clock.clock_id`](#subscription.u.clock.clock_id).

### <a href="#subscription" name="subscription"></a>`uvwasi_subscription_t` (`struct`)

Subscription to an event.

Used by [`uvwasi_poll_oneoff()`](#poll_oneoff).

Members:

- <a href="#subscription.userdata" name="subscription.userdata"></a><code>[\_\_wasi_userdata_t](#userdata) <strong>userdata</strong></code>

  User-provided value that is attached to the subscription in the
  implementation and returned through
  [`uvwasi_event_t::userdata`](#event.userdata).

- <a href="#subscription.type" name="subscription.type"></a><code>[\_\_wasi_eventtype_t](#eventtype) <strong>type</strong></code>

  The type of the event to which to subscribe.

- When `type` is [`UVWASI_EVENTTYPE_CLOCK`](#eventtype.u.clock):
  - <a href="#subscription.u.clock" name="subscription.u.clock"></a>**`u.clock`**
    - <a href="#subscription.u.clock.clock_id" name="subscription.u.clock.clock_id"></a><code>[\_\_wasi_clockid_t](#clockid) <strong>clock_id</strong></code>

      The clock against which to compare the timestamp.

    - <a href="#subscription.u.clock.timeout" name="subscription.u.clock.timeout"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>timeout</strong></code>

      The absolute or relative timestamp.

    - <a href="#subscription.u.clock.precision" name="subscription.u.clock.precision"></a><code>[\_\_wasi_timestamp_t](#timestamp) <strong>precision</strong></code>

      The amount of time that the implementation may wait additionally
      to coalesce with other events.

    - <a href="#subscription.u.clock.flags" name="subscription.u.clock.flags"></a><code>[\_\_wasi_subclockflags_t](#subclockflags) <strong>flags</strong></code>

      Flags specifying whether the timeout is absolute or relative.

- When `type` is [`UVWASI_EVENTTYPE_FD_READ`](#eventtype.fd_read) or [`UVWASI_EVENTTYPE_FD_WRITE`](#eventtype.fd_write):
  - <a href="#subscription.u.fd_readwrite" name="subscription.u.fd_readwrite"></a>**`u.fd_readwrite`**
    - <a href="#subscription.u.fd_readwrite.fd" name="subscription.u.fd_readwrite.fd"></a><code>[\_\_wasi_fd_t](#fd) <strong>fd</strong></code>

      The file descriptor on which to wait for it to become ready
      for reading or writing.

### <a href="#timestamp" name="timestamp"></a>`uvwasi_timestamp_t` (`uint64_t`)

Timestamp in nanoseconds.

Used by [`uvwasi_filestat_t`](#filestat), [`uvwasi_subscription_t`](#subscription), [`uvwasi_clock_res_get()`](#clock_res_get), [`uvwasi_clock_time_get()`](#clock_time_get), [`uvwasi_fd_filestat_set_times()`](#fd_filestat_set_times), and [`uvwasi_path_filestat_set_times()`](#path_filestat_set_times).

### <a href="#userdata" name="userdata"></a>`uvwasi_userdata_t` (`uint64_t`)

User-provided value that may be attached to objects that is
retained when extracted from the implementation.

Used by [`uvwasi_event_t`](#event) and [`uvwasi_subscription_t`](#subscription).

### <a href="#whence" name="whence"></a>`uvwasi_whence_t` (`uint8_t`)

The position relative to which to set the offset of the file descriptor.

Used by [`uvwasi_fd_seek()`](#fd_seek).

Possible values:

- <a href="#whence.cur" name="whence.cur"></a>**`UVWASI_WHENCE_CUR`**

  Seek relative to current position.

- <a href="#whence.end" name="whence.end"></a>**`UVWASI_WHENCE_END`**

  Seek relative to end-of-file.

- <a href="#whence.set" name="whence.set"></a>**`UVWASI_WHENCE_SET`**

  Seek relative to start-of-file.

## Doing a release

To do a release complete the following steps:

- Look at the list of changes - https://github.com/nodejs/uvwasi/commits/main.
- Put together a list of notable changes.
  See https://github.com/nodejs/uvwasi/releases/tag/v0.0.14
  or any of the other releases for example. Use that list in the release commit,
  the GitHub release, and the PR to update uvwasi in Node.js (or any other
  projects where you update it)
- Update the version in the CMake file. Specifically: https://github.com/nodejs/uvwasi/blob/main/CMakeLists.txt#L5
- Create a release commit. This should just involve changing one line and
  adding the notable changes. See
  https://github.com/nodejs/uvwasi/commit/6ad5fc996420d0e4e75983ce3deb65f327321f33
  as an example.
- PR the release commit. Once it lands, create a GitHub release with
  the same notable changes. When doing the GitHub release you will need to select
  `Choose a tag` and type in the new tag. That should result in
  ` Create new tag: vX.Y.Z on publish` where vX.Y.Z matches the tag you specified.
- Update uvwasi in Node.js or any projects you want to update - there are several
  other projects that use uvwasi.

## Running fuzzers locally

We support fuzzing by way of [ClusterFuzzLite](https://google.github.io/clusterfuzzlite/),
which is run automatically against pull requests. You can run these fuzzers
locally with the [OSS-Fuzz](https://github.com/google/oss-fuzz) fuzzing
infrastructure, using the following steps:

```sh
git clone https://github.com/google/oss-fuzz
git clone https://github.com/nodejs/uvwasi
cd uvwasi

# Build the fuzzers in .clusterfuzzlite
python3 ../oss-fuzz/infra/helper.py build_fuzzers --external $PWD

# Run the fuzzer for 10 seconds
python3 ../oss-fuzz/infra/helper.py run_fuzzer --external $PWD fuzz_normalize_path -- -max_total_time=10
```

[WASI]: https://github.com/WebAssembly/WASI
[libuv]: https://github.com/libuv/libuv
[preview 1]: https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md
