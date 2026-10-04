# Linux Companion: WebKitGTK 2.54.1 AppImage qualification

This is a **reproducible, opt-in build procedure**, not a claim that every Linux
AppImage should replace its distribution WebKitGTK. It documents the Ubuntu
24.04 x86_64 build used to test clipboard images and Dolphin file attachments.
The normal Companion source changes (native file bridge and reduced-motion
control) are independent of this locally built WebKit runtime.

## In plain terms

The Linux Companion is a desktop window around the OpenClaw interface. An
**AppImage** is the single downloadable file that starts that window.
**WebKitGTK** is the browser engine inside it. WebKit also starts small
helper programs for web pages and networking.

The work addresses three separate problems:

| What users saw | What fixes it |
| --- | --- |
| A pasted screenshot did not arrive | Bundle WebKitGTK 2.54.1, which exposes the image to the page |
| Copy/paste or drag-and-drop of a file from the file manager did not arrive | Let the Companion read the user-selected local file and pass it to the existing attachment handler |
| The Home spinner and other animations kept the interface busy | Offer an optional “Reduce animations” switch in the Companion settings |

The custom WebKit build needs one extra correction: the AppImage moves between
machines, so its helper programs cannot be looked up at the build machine's
fixed /opt path. The patch and packaging script below make WebKit find the
helpers **inside the AppImage**. This only changes the locally built AppImage;
it is not a Gateway change or a system-wide WebKit installation.

## Why this runtime

On Ubuntu 24.04, the tested distribution WebKitGTK 2.52.6 exposed an image
copied from the desktop as `clipboardData.files.length === 0` in the WebView.
With WebKitGTK **2.54.1**, the same GTK clipboard-image probe exposed an
`image/png` file. That version alone did **not** fix Dolphin file clipboard
or drop: URI clipboard entries still had no DOM `File`, and Tauri captured the
native drop before the Gateway-served page received it. The Companion bridge
handles those gestures separately. File clipboard reads require a recent native
Ctrl+V in the same WebView, and are single-use; a dashboard command alone cannot
read clipboard-selected files. Drop tokens are scoped to their receiving WebView
and current document. An error is shown in the chat window when the selected
file cannot be attached.

The AppImage must carry the matching WebKitGTK library, its three subprocesses,
and its injected bundle. The first package carried the 2.54.1 library but
packaged older helpers. A subsequent package included the correct helpers yet
failed outside the build container: release WebKit had compiled in an absolute
`/opt/.../WebKitNetworkProcess` path and ignored `WEBKIT_EXEC_PATH`. The patch in
[`patches/webkitgtk-2.54.1-appimage-runtime.diff`](patches/webkitgtk-2.54.1-appimage-runtime.diff)
makes release WebKit honor that variable and gives its Bubblewrap sandbox
access to the AppImage mount (`APPDIR`). Both changes are needed. They do not
disable the sandbox.

## Build the matching WebKitGTK

Use an isolated **Ubuntu 24.04 x86_64** build environment with the WebKitGTK
build dependencies and the OpenClaw Linux/Tauri dependencies installed. Do not
install this custom WebKit over the host distribution. Build from the upstream
`webkitgtk-2.54.1.tar.xz` source release. Its tested SHA-256 is
`ea0bbb02dbdbc596874a4e7ad35b66645b3e0a232bd0e4081de5ed92eb0a397d`.
Verify the tarball checksum and upstream release signature before applying the
local patch. Example, from the repository root:

```sh
sha256sum webkitgtk-2.54.1.tar.xz
mkdir -p webkit-build-source
# Extract into an isolated directory; the archive creates webkitgtk-2.54.1/.
tar -xJf webkitgtk-2.54.1.tar.xz -C webkit-build-source
patch --directory=webkit-build-source/webkitgtk-2.54.1 --strip=1 \
  < apps/linux/patches/webkitgtk-2.54.1-appimage-runtime.diff
cmake -S webkit-build-source/webkitgtk-2.54.1 -B webkit-build \
  -G Ninja -DPORT=GTK -DUSE_GTK4=OFF -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr \
  -DCMAKE_INSTALL_LIBDIR=lib/x86_64-linux-gnu \
  -DEXEC_INSTALL_DIR=/opt/webkitgtk-2.54.1/bin \
  -DLIB_INSTALL_DIR=/opt/webkitgtk-2.54.1/lib/x86_64-linux-gnu \
  -DLIBEXEC_INSTALL_DIR=/opt/webkitgtk-2.54.1/libexec/webkit2gtk-4.1 \
  -DENABLE_DOCUMENTATION=OFF -DENABLE_INTROSPECTION=OFF \
  -DENABLE_MINIBROWSER=OFF -DENABLE_GAMEPAD=OFF -DENABLE_WEBXR=OFF \
  -DENABLE_SPEECH_SYNTHESIS=OFF -DUSE_LIBBACKTRACE=OFF
cmake --build webkit-build --parallel 4
cmake --install webkit-build
```

The prefix and install-directory values above match the tested CMake cache: its
main prefix was `/usr`, while WebKit libraries and helpers were installed
under `/opt/webkitgtk-2.54.1`. Confirm the paths in your own cache and install
tree; changing them changes the baked-in fallback helper path. These feature
flags omit optional features that were not needed for this qualification. Review them before using this
runtime as a general-purpose WebKit distribution. The installed prefix should
report `webkit2gtk-4.1` version 2.54.1 through its `pkg-config` file.

## Package the AppImage

Build the Linux Companion with the project’s Tauri AppImage path while the
custom WebKitGTK pkg-config directory and library directory take precedence.
Check that the generated AppDir contains the matching 2.54.1
`libwebkit2gtk-4.1.so.*`, then stage the helpers **before finalizing** the
AppImage:

```sh
apps/linux/scripts/stage-webkitgtk-appimage.sh \
  apps/linux/src-tauri/target/release/bundle/appimage/OpenClaw.AppDir \
  /opt/webkitgtk-2.54.1
apps/linux/scripts/finalize-appimage.sh \
  apps/linux/src-tauri/target/release/bundle/appimage
```

`stage-webkitgtk-appimage.sh` requires the compiled WebKitGTK prefix and will
not silently replace an already-patched AppRun. The exact package name and
AppDir layout may change with Tauri; inspect them before running the command.
The checksum-pinned AppImage-tool manifest must also be verified. In the
original build, its `continuous` plugin asset changed upstream; use a pinned,
verified immutable asset in production CI rather than trusting a mutable URL.

## Qualification gates

1. Compare the bundled WebKit library and subprocesses with the compiled
   2.54.1 files (Build ID or SHA-256); a library-only version check is not
   enough.
2. Run the final AppImage with the build prefix **unavailable** (for example,
   in an isolated mount namespace with `/opt/webkitgtk-2.54.1` hidden). Verify
   `WebKitNetworkProcess` and `WebKitWebProcess` launch from the extracted or
   mounted AppImage. The build container alone masked the original failure.
3. Exercise image clipboard paste, file-URI paste, and a real native file
   drag into the connected dashboard WebView. Also check first-run UI and the
   packaged runtime smoke test.
4. On the target desktop, verify normal FUSE mounting, the actual file manager
   gestures, and the reduced-motion control. An Xvfb/GTK test does not prove
   KDE/Wayland behavior.

On the tested TUXEDO machine, the user confirmed that an image file copied
from Dolphin and the same file dragged from Dolphin both arrived as chat
attachments. A separate screenshot paste and AppImage launch were also
confirmed. The optional reduced-motion mode was observed to stop the spinning
Home indicator. The exact AppImage revision for the two Dolphin reports was
not repeated in those messages, so this document does not attribute them to a
specific revision. A CPU profile of a connected Companion in an Ubuntu/Xvfb
VM showed a reversible reduction with reduced motion, but those numbers are
**not** a quantitative TUXEDO/KDE measurement.
