
XZ Utils
========

    0. Overview
    1. Documentation
       1.1. Overall documentation
       1.2. Documentation for command-line tools
       1.3. Documentation for liblzma
    2. Version numbering
    3. Reporting bugs
    4. Translations
       4.1. Testing translations
    5. Other implementations of the .xz format
    6. Contact information


0. Overview
-----------

    XZ Utils provide a general-purpose data-compression library plus
    command-line tools. The native file format is the .xz format, but
    also the legacy .lzma format is supported. The .xz format supports
    multiple compression algorithms, which are called "filters" in the
    context of XZ Utils. The primary filter is currently LZMA2. With
    typical files, XZ Utils create about 30 % smaller files than gzip.

    To ease adapting support for the .xz format into existing applications
    and scripts, the API of liblzma is somewhat similar to the API of the
    popular zlib library. For the same reason, the command-line tool xz
    has a command-line syntax similar to that of gzip.

    When aiming for the highest compression ratio, the LZMA2 encoder uses
    a lot of CPU time and may use, depending on the settings, even
    hundreds of megabytes of RAM. However, in fast modes, the LZMA2 encoder
    competes with bzip2 in compression speed, RAM usage, and compression
    ratio.

    LZMA2 is reasonably fast to decompress. It is a little slower than
    gzip, but a lot faster than bzip2. Being fast to decompress means
    that the .xz format is especially nice when the same file will be
    decompressed very many times (usually on different computers), which
    is the case e.g. when distributing software packages. In such
    situations, it's not too bad if the compression takes some time,
    since that needs to be done only once to benefit many people.

    With some file types, combining (or "chaining") LZMA2 with an
    additional filter can improve the compression ratio. A filter chain may
    contain up to four filters, although usually only one or two are used.
    For example, putting a BCJ (Branch/Call/Jump) filter before LZMA2
    in the filter chain can improve compression ratio of executable files.

    Since the .xz format allows adding new filter IDs, it is possible that
    some day there will be a filter that is, for example, much faster to
    compress than LZMA2 (but probably with worse compression ratio).
    Similarly, it is possible that some day there is a filter that will
    compress better than LZMA2.

    XZ Utils supports multithreaded compression. XZ Utils doesn't support
    multithreaded decompression yet. It has been planned though and taken
    into account when designing the .xz file format. In the future, files
    that were created in threaded mode can be decompressed in threaded
    mode too.


1. Documentation
----------------

1.1. Overall documentation

    README                This file

    INSTALL.generic       Generic install instructions for those not
                          familiar with packages using GNU Autotools
    INSTALL               Installation instructions specific to XZ Utils
    PACKAGERS             Information to packagers of XZ Utils

    COPYING               XZ Utils copyright and license information
    COPYING.0BSD          BSD Zero Clause License
    COPYING.GPLv2         GNU General Public License version 2
    COPYING.GPLv3         GNU General Public License version 3
    COPYING.LGPLv2.1      GNU Lesser General Public License version 2.1

    AUTHORS               The main authors of XZ Utils
    THANKS                Incomplete list of people who have helped making
                          this software
    NEWS                  User-visible changes between XZ Utils releases
    ChangeLog             Detailed list of changes (commit log)
    TODO                  Known bugs and some sort of to-do list

    Note that only some of the above files are included in binary
    packages.


1.2. Documentation for command-line tools

    The command-line tools are documented as man pages. In source code
    releases (and possibly also in some binary packages), the man pages
    are also provided in plain text (ASCII only) format in the directory
    "doc/man" to make the man pages more accessible to those whose
    operating system doesn't provide an easy way to view man pages.


1.3. Documentation for liblzma

    The liblzma API headers include short docs about each function
    and data type as Doxygen tags. These docs should be quite OK as
    a quick reference.

    There are a few example/tutorial programs that should help in
    getting started with liblzma. In the source package the examples
    are in "doc/examples" and in binary packages they may be under
    "examples" in the same directory as this README.

    Since the liblzma API has similarities to the zlib API, some people
    may find it useful to read the zlib docs and tutorial too:

        https://zlib.net/manual.html
        https://zlib.net/zlib_how.html


2. Version numbering
--------------------

    The version number format of XZ Utils is X.Y.ZS:

      - X is the major version. When this is incremented, the library
        API and ABI break.

      - Y is the minor version. It is incremented when new features
        are added without breaking the existing API or ABI. An even Y
        indicates a stable release and an odd Y indicates unstable
        (alpha or beta version).

      - Z is the revision. This has a different meaning for stable and
        unstable releases:

          * Stable: Z is incremented when bugs get fixed without adding
            any new features. This is intended to be convenient for
            downstream distributors that want bug fixes but don't want
            any new features to minimize the risk of introducing new bugs.

          * Unstable: Z is just a counter. API or ABI of features added
            in earlier unstable releases having the same X.Y may break.

      - S indicates stability of the release. It is missing from the
        stable releases, where Y is an even number. When Y is odd, S
        is either "alpha" or "beta" to make it very clear that such
        versions are not stable releases. The same X.Y.Z combination is
        not used for more than one stability level, i.e. after X.Y.Zalpha,
        the next version can be X.Y.(Z+1)beta but not X.Y.Zbeta.


3. Reporting bugs
-----------------

    Naturally it is easiest for me if you already know what causes the
    unexpected behavior. Even better if you have a patch to propose.
    However, quite often the reason for unexpected behavior is unknown,
    so here are a few things to do before sending a bug report:

      1. Try to create a small example how to reproduce the issue.

      2. Compile XZ Utils with debugging code using configure switches
         --enable-debug and, if possible, --disable-shared. If you are
         using GCC, use CFLAGS='-O0 -ggdb3'. Don't strip the resulting
         binaries.

      3. Turn on core dumps. The exact command depends on your shell;
         for example in GNU bash it is done with "ulimit -c unlimited",
         and in tcsh with "limit coredumpsize unlimited".

      4. Try to reproduce the suspected bug. If you get "assertion failed"
         message, be sure to include the complete message in your bug
         report. If the application leaves a coredump, get a backtrace
         using gdb:
           $ gdb /path/to/app-binary   # Load the app to the debugger.
           (gdb) core core   # Open the coredump.
           (gdb) bt   # Print the backtrace. Copy & paste to bug report.
           (gdb) quit   # Quit gdb.

    Report your bug via email or IRC (see Contact information below).
    Don't send core dump files or any executables. If you have a small
    example file(s) (total size less than 256 KiB), please include
    it/them as an attachment. If you have bigger test files, put them
    online somewhere and include a URL to the file(s) in the bug report.

    Always include the exact version number of XZ Utils in the bug report.
    If you are using a snapshot from the git repository, use "git describe"
    to get the exact snapshot version. If you are using XZ Utils shipped
    in an operating system distribution, mention the distribution name,
    distribution version, and exact xz package version; if you cannot
    repeat the bug with the code compiled from unpatched source code,
    you probably need to report a bug to your distribution's bug tracking
    system.


4. Translations
---------------

    The xz command line tool and all man pages can be translated.
    The translations are handled via the Translation Project. If you
    wish to help translating xz, please join the Translation Project:

        https://translationproject.org/html/translators.html

    Updates to translations won't be accepted by methods that bypass
    the Translation Project because there is a risk of duplicate work:
    translation updates made in the xz repository aren't seen by the
    translators in the Translation Project. If you have found bugs in
    a translation, please report them to the Language-Team address
    which can be found near the beginning of the PO file.

    If you find language problems in the original English strings,
    feel free to suggest improvements. Ask if something is unclear.


4.1. Testing translations

    Testing can be done by installing xz into a temporary directory.

    If building from Git repository (not tarball), generate the
    Autotools files:

        ./autogen.sh

    Create a subdirectory for the build files. The tmp-build directory
    can be deleted after testing.

        mkdir tmp-build
        cd tmp-build
        ../configure --disable-shared --enable-debug --prefix=$PWD/inst

    Edit the .po file in the po directory. Then build and install to
    the "tmp-build/inst" directory, and use translations.bash to see
    how some of the messages look. Repeat these  steps if needed:

        make -C po update-po
        make -j"$(nproc)" install
        bash ../debug/translation.bash | less
        bash ../debug/translation.bash | less -S  # For --list outputs

    To test other languages, set the LANGUAGE environment variable
    before running translations.bash. The value should match the PO file
    name without the .po suffix. Example:

        export LANGUAGE=fi


5. Other implementations of the .xz format
------------------------------------------

    7-Zip and the p7zip port of 7-Zip support the .xz format starting
    from the version 9.00alpha.

        https://7-zip.org/
        https://p7zip.sourceforge.net/

    XZ Embedded is a limited implementation written for use in the Linux
    kernel, but it is also suitable for other embedded use.

        https://tukaani.org/xz/embedded.html

    XZ for Java is a complete implementation written in pure Java.

        https://tukaani.org/xz/java.html


6. Contact information
----------------------

    XZ Utils in general:
      - Home page: https://tukaani.org/xz/
      - Email to maintainer(s): xz@tukaani.org
      - IRC: #tukaani on Libera Chat
      - GitHub: https://github.com/tukaani-project/xz

    Lead maintainer:
      - Email: Lasse Collin <lasse.collin@tukaani.org>
      - IRC: Larhzu on Libera Chat

