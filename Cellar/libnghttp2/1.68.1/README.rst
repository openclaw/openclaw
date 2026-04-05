nghttp2 - HTTP/2 C Library
==========================

This is an implementation of the Hypertext Transfer Protocol version 2
in C.

The framing layer of HTTP/2 is implemented as a reusable C library.
On top of that, we have implemented an HTTP/2 client, server and
proxy.  We have also developed load test and benchmarking tools for
HTTP/2.

An HPACK encoder and decoder are available as a public API.

Development Status
------------------

nghttp2 was originally developed based on `RFC 7540
<https://tools.ietf.org/html/rfc7540>`_ HTTP/2 and `RFC 7541
<https://tools.ietf.org/html/rfc7541>`_ HPACK - Header Compression for
HTTP/2.  Now we are updating our code to implement `RFC 9113
<https://datatracker.ietf.org/doc/html/rfc9113>`_.

The nghttp2 code base was forked from the spdylay
(https://github.com/tatsuhiro-t/spdylay) project.

Public Test Server
------------------

The following endpoints are available to try out our nghttp2
implementation.

* https://nghttp2.org/ (TLS + ALPN and HTTP/3)

  This endpoint supports ``h2`` and ``http/1.1`` via ALPN and requires
  TLSv1.2 for HTTP/2 connection.

  It also supports HTTP/3.

* http://nghttp2.org/ (HTTP Upgrade and HTTP/2 Direct)

  ``h2c`` and ``http/1.1``.

Requirements
------------

The following package is required to build the libnghttp2 library:

* pkg-config >= 0.20

To build the documentation, you need to install:

* sphinx (http://sphinx-doc.org/)

If you need libnghttp2 (C library) only, then the above packages are
all you need.  Use ``--enable-lib-only`` to ensure that only
libnghttp2 is built.  This avoids potential build error related to
building bundled applications.

To build and run the application programs (``nghttp``, ``nghttpd``,
``nghttpx`` and ``h2load``) in the ``src`` directory, the following packages
are required:

* OpenSSL >= 1.1.1; or wolfSSL >= 5.7.0; or LibreSSL >= 3.8.1; or
  aws-lc >= 1.19.0; or BoringSSL
* libev >= 4.11
* zlib >= 1.2.3
* libc-ares >= 1.7.5

To enable ``-a`` option (getting linked assets from the downloaded
resource) in ``nghttp``, the following package is required:

* libxml2 >= 2.6.26

To enable systemd support in nghttpx, the following package is
required:

* libsystemd-dev >= 209

The HPACK tools require the following package:

* jansson >= 2.5

To build sources under the examples directory, libevent is required:

* libevent-openssl >= 2.0.8

To mitigate heap fragmentation in long running server programs
(``nghttpd`` and ``nghttpx``), jemalloc is recommended:

* jemalloc

  .. note::

     Alpine Linux currently does not support malloc replacement
     due to musl limitations. See details in issue `#762 <https://github.com/nghttp2/nghttp2/issues/762>`_.

For BoringSSL or aws-lc build, to enable :rfc:`8879` TLS Certificate
Compression in applications, the following library is required:

* libbrotli-dev >= 1.0.9

To enable mruby support for nghttpx, `mruby
<https://github.com/mruby/mruby>`_ is required.  We need to build
mruby with C++ ABI explicitly turned on, and probably need other
mrgems, mruby is managed by git submodule under third-party/mruby
directory.  Currently, mruby support for nghttpx is disabled by
default.  To enable mruby support, use ``--with-mruby`` configure
option.  Note that at the time of this writing, libmruby-dev and mruby
packages in Debian/Ubuntu are not usable for nghttp2, since they do
not enable C++ ABI.  To build mruby, the following packages are
required:

* ruby
* bison

nghttpx supports `neverbleed <https://github.com/h2o/neverbleed>`_,
privilege separation engine for OpenSSL.  In short, it minimizes the
risk of private key leakage when serious bug like Heartbleed is
exploited.  The neverbleed is disabled by default.  To enable it, use
``--with-neverbleed`` configure option.

To enable the experimental HTTP/3 support for h2load and nghttpx, the
following libraries are required:

* `quictls
  <https://github.com/quictls/openssl/tree/OpenSSL_1_1_1w+quic>`_; or
  wolfSSL; or LibreSSL (does not support 0RTT); or aws-lc; or
  `BoringSSL <https://boringssl.googlesource.com/boringssl/>`_ (commit
  db1a8456167249f95b854a1cd24c6b553d0f1567); or OpenSSL >= 3.5.0
* `ngtcp2 <https://github.com/ngtcp2/ngtcp2>`_ >= 1.16.0
* `nghttp3 <https://github.com/ngtcp2/nghttp3>`_ >= 1.12.0

Use ``--enable-http3`` configure option to enable HTTP/3 feature for
h2load and nghttpx.

In order to build optional eBPF program to direct an incoming QUIC UDP
datagram to a correct socket for nghttpx, the following libraries are
required:

* libbpf-dev >= 0.7.0

Use ``--with-libbpf`` configure option to build eBPF program.
libelf-dev is needed to build libbpf.

For Ubuntu 20.04, you can build libbpf from `the source code
<https://github.com/libbpf/libbpf/releases>`_.  nghttpx requires eBPF
program for reloading its configuration and hot swapping its
executable.

Compiling libnghttp2 C source code requires a C99 compiler.  gcc 4.8
is known to be adequate.  In order to compile the C++ source code,
C++20 compliant compiler is required.  At least g++ >= 12 and
clang++ >= 18 are known to work.

.. note::

   To enable mruby support in nghttpx, and use ``--with-mruby``
   configure option.

.. note::

   Mac OS X users may need the ``--disable-threads`` configure option to
   disable multi-threading in nghttpd, nghttpx and h2load to prevent
   them from crashing. A patch is welcome to make multi threading work
   on Mac OS X platform.

.. note::

   To compile the associated applications (nghttp, nghttpd, nghttpx
   and h2load), you must use the ``--enable-app`` configure option and
   ensure that the specified requirements above are met.  Normally,
   configure script checks required dependencies to build these
   applications, and enable ``--enable-app`` automatically, so you
   don't have to use it explicitly.  But if you found that
   applications were not built, then using ``--enable-app`` may find
   that cause, such as the missing dependency.

.. note::

   In order to detect third party libraries, pkg-config is used
   (however we don't use pkg-config for some libraries (e.g., libev)).
   By default, pkg-config searches ``*.pc`` file in the standard
   locations (e.g., /usr/lib/pkgconfig).  If it is necessary to use
   ``*.pc`` file in the custom location, specify paths to
   ``PKG_CONFIG_PATH`` environment variable, and pass it to configure
   script, like so:

   .. code-block:: text

       $ ./configure PKG_CONFIG_PATH=/path/to/pkgconfig

   For pkg-config managed libraries, ``*_CFLAG`` and ``*_LIBS``
   environment variables are defined (e.g., ``OPENSSL_CFLAGS``,
   ``OPENSSL_LIBS``).  Specifying non-empty string to these variables
   completely overrides pkg-config.  In other words, if they are
   specified, pkg-config is not used for detection, and user is
   responsible to specify the correct values to these variables.  For
   complete list of these variables, run ``./configure -h``.

If you are using Ubuntu 22.04 LTS, run the following to install the
required packages:

.. code-block:: text

    sudo apt-get install g++ clang make binutils autoconf automake \
      autotools-dev libtool pkg-config \
      zlib1g-dev libssl-dev libxml2-dev libev-dev \
      libevent-dev libjansson-dev \
      libc-ares-dev libjemalloc-dev libsystemd-dev \
      ruby-dev bison libelf-dev

Building nghttp2 from release tar archive
-----------------------------------------

The nghttp2 project regularly releases tar archives which includes
nghttp2 source code, and generated build files.  They can be
downloaded from `Releases
<https://github.com/nghttp2/nghttp2/releases>`_ page.

Building nghttp2 from git requires autotools development packages.
Building from tar archives does not require them, and thus it is much
easier.  The usual build step is as follows:

.. code-block:: text

    $ tar xf nghttp2-X.Y.Z.tar.bz2
    $ cd nghttp2-X.Y.Z
    $ ./configure
    $ make

Building from git
-----------------

Building from git is easy, but please be sure that at least autoconf 2.68 is
used:

.. code-block:: text

    $ git submodule update --init
    $ autoreconf -i
    $ automake
    $ autoconf
    $ ./configure
    $ make

Notes for building on Windows (MSVC)
------------------------------------

The easiest way to build native Windows nghttp2 dll is use `cmake
<https://cmake.org/>`_.  The free version of `Visual C++ Build Tools
<http://landinghub.visualstudio.com/visual-cpp-build-tools>`_ works
fine.

1. Install cmake for windows
2. Open "Visual C++ ... Native Build Tool Command Prompt", and inside
   nghttp2 directly, run ``cmake``.
3. Then run ``cmake --build`` to build library.
4. nghttp2.dll, nghttp2.lib, nghttp2.exp are placed under lib directory.

Note that the above steps most likely produce nghttp2 library only.
No bundled applications are compiled.

Notes for building on Windows (Mingw/Cygwin)
--------------------------------------------

Under Mingw environment, you can only compile the library, it's
``libnghttp2-X.dll`` and ``libnghttp2.a``.

If you want to compile the applications(``h2load``, ``nghttp``,
``nghttpx``, ``nghttpd``), you need to use the Cygwin environment.

Under Cygwin environment, to compile the applications you need to
compile and install the libev first.

Secondly, you need to undefine the macro ``__STRICT_ANSI__``, if you
not, the functions ``fdopen``, ``fileno`` and ``strptime`` will not
available.

the sample command like this:

.. code-block:: text

    $ export CFLAGS="-U__STRICT_ANSI__ -I$libev_PREFIX/include -L$libev_PREFIX/lib"
    $ export CXXFLAGS=$CFLAGS
    $ ./configure
    $ make

If you want to compile the applications under ``examples/``, you need
to remove or rename the ``event.h`` from libev's installation, because
it conflicts with libevent's installation.

Notes for installation on Linux systems
--------------------------------------------
After installing nghttp2 tool suite with ``make install`` one might experience a similar error:

.. code-block:: text

    nghttpx: error while loading shared libraries: libnghttp2.so.14: cannot open shared object file: No such file or directory

This means that the tool is unable to locate the ``libnghttp2.so`` shared library.

To update the shared library cache run ``sudo ldconfig``.

Building the documentation
--------------------------

.. note::

   Documentation is still incomplete.

To build the documentation, run:

.. code-block:: text

    $ make html

The documents will be generated under ``doc/manual/html/``.

The generated documents will not be installed with ``make install``.

The online documentation is available at
https://nghttp2.org/documentation/

Build HTTP/3 enabled h2load and nghttpx
---------------------------------------

To build h2load and nghttpx with HTTP/3 feature enabled, run the
configure script with ``--enable-http3``.

For nghttpx to reload configurations and swapping its executable while
gracefully terminating old worker processes, eBPF is required.  Run
the configure script with ``--enable-http3 --with-libbpf`` to build
eBPF program.  The QUIC keying material must be set with
``--frontend-quic-secret-file`` in order to keep the existing
connections alive during reload.

The detailed steps to build HTTP/3 enabled h2load and nghttpx follow.

Build aws-lc:

.. code-block:: text

   $ git clone --depth 1 -b v1.62.0 https://github.com/aws/aws-lc
   $ cd aws-lc
   $ cmake -B build -DDISABLE_GO=ON --install-prefix=$PWD/opt
   $ make -j$(nproc) -C build
   $ cmake --install build
   $ cd ..

Build nghttp3:

.. code-block:: text

   $ git clone --depth 1 -b v1.12.0 https://github.com/ngtcp2/nghttp3
   $ cd nghttp3
   $ git submodule update --init --depth 1
   $ autoreconf -i
   $ ./configure --prefix=$PWD/build --enable-lib-only
   $ make -j$(nproc)
   $ make install
   $ cd ..

Build ngtcp2:

.. code-block:: text

   $ git clone --depth 1 -b v1.17.0 https://github.com/ngtcp2/ngtcp2
   $ cd ngtcp2
   $ git submodule update --init --depth 1
   $ autoreconf -i
   $ ./configure --prefix=$PWD/build --enable-lib-only --with-boringssl \
         BORINGSSL_CFLAGS="-I$PWD/../aws-lc/opt/include" \
         BORINGSSL_LIBS="-L$PWD/../aws-lc/opt/lib -lssl -lcrypto"
   $ make -j$(nproc)
   $ make install
   $ cd ..

If your Linux distribution does not have libbpf-dev >= 0.7.0, build
from source:

.. code-block:: text

   $ git clone --depth 1 -b v1.6.2 https://github.com/libbpf/libbpf
   $ cd libbpf
   $ PREFIX=$PWD/build make -C src install
   $ cd ..

Build nghttp2:

.. code-block:: text

   $ git clone https://github.com/nghttp2/nghttp2
   $ cd nghttp2
   $ git submodule update --init
   $ autoreconf -i
   $ ./configure --with-mruby --enable-http3 --with-libbpf \
         CC=clang-19 CXX=clang++-19 \
         PKG_CONFIG_PATH="$PWD/../aws-lc/opt/lib/pkgconfig:$PWD/../nghttp3/build/lib/pkgconfig:$PWD/../ngtcp2/build/lib/pkgconfig:$PWD/../libbpf/build/lib64/pkgconfig" \
         LDFLAGS="$LDFLAGS -Wl,-rpath,$PWD/../aws-lc/opt/lib -Wl,-rpath,$PWD/../libbpf/build/lib64"
   $ make -j$(nproc)

The eBPF program ``reuseport_kern.o`` should be found under bpf
directory.  Pass ``--quic-bpf-program-file=bpf/reuseport_kern.o``
option to nghttpx to load it.  See also `HTTP/3 section in nghttpx -
HTTP/2 proxy - HOW-TO
<https://nghttp2.org/documentation/nghttpx-howto.html#http-3>`_.

Unit tests
----------

Unit tests are done by simply running ``make check``.

Integration tests
-----------------

We have the integration tests for the nghttpx proxy server.  The tests are
written in the `Go programming language <http://golang.org/>`_ and uses
its testing framework.  We depend on the following libraries:

* golang.org/x/net/http2
* golang.org/x/net/websocket
* https://github.com/tatsuhiro-t/go-nghttp2

Go modules will download these dependencies automatically.

To run the tests, run the following command under
``integration-tests`` directory:

.. code-block:: text

    $ make it

Inside the tests, we use port 3009 to run the test subject server.

Migration from v0.7.15 or earlier
---------------------------------

nghttp2 v1.0.0 introduced several backward incompatible changes.  In
this section, we describe these changes and how to migrate to v1.0.0.

ALPN protocol ID is now ``h2`` and ``h2c``
++++++++++++++++++++++++++++++++++++++++++

Previously we announced ``h2-14`` and ``h2c-14``.  v1.0.0 implements
final protocol version, and we changed ALPN ID to ``h2`` and ``h2c``.
The macros ``NGHTTP2_PROTO_VERSION_ID``,
``NGHTTP2_PROTO_VERSION_ID_LEN``,
``NGHTTP2_CLEARTEXT_PROTO_VERSION_ID``, and
``NGHTTP2_CLEARTEXT_PROTO_VERSION_ID_LEN`` have been updated to
reflect this change.

Basically, existing applications do not have to do anything, just
recompiling is enough for this change.

Use word "client magic" where we use "client connection preface"
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

We use "client connection preface" to mean first 24 bytes of client
connection preface.  This is technically not correct, since client
connection preface is composed of 24 bytes client magic byte string
followed by SETTINGS frame.  For clarification, we call "client magic"
for this 24 bytes byte string and updated API.

* ``NGHTTP2_CLIENT_CONNECTION_PREFACE`` was replaced with
  ``NGHTTP2_CLIENT_MAGIC``.
* ``NGHTTP2_CLIENT_CONNECTION_PREFACE_LEN`` was replaced with
  ``NGHTTP2_CLIENT_MAGIC_LEN``.
* ``NGHTTP2_BAD_PREFACE`` was renamed as ``NGHTTP2_BAD_CLIENT_MAGIC``

The already deprecated ``NGHTTP2_CLIENT_CONNECTION_HEADER`` and
``NGHTTP2_CLIENT_CONNECTION_HEADER_LEN`` were removed.

If application uses these macros, just replace old ones with new ones.
Since v1.0.0, client magic is sent by library (see next subsection),
so client application may just remove these macro use.

Client magic is sent by library
+++++++++++++++++++++++++++++++

Previously nghttp2 library did not send client magic, which is first
24 bytes byte string of client connection preface, and client
applications have to send it by themselves.  Since v1.0.0, client
magic is sent by library via first call of ``nghttp2_session_send()``
or ``nghttp2_session_mem_send2()``.

The client applications which send client magic must remove the
relevant code.

Remove HTTP Alternative Services (Alt-Svc) related code
+++++++++++++++++++++++++++++++++++++++++++++++++++++++

Alt-Svc specification is not finalized yet.  To make our API stable,
we have decided to remove all Alt-Svc related API from nghttp2.

* ``NGHTTP2_EXT_ALTSVC`` was removed.
* ``nghttp2_ext_altsvc`` was removed.

We have already removed the functionality of Alt-Svc in v0.7 series
and they have been essentially noop.  The application using these
macro and struct, remove those lines.

Use nghttp2_error in nghttp2_on_invalid_frame_recv_callback
+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

Previously ``nghttp2_on_invalid_frame_recv_cb_called`` took the
``error_code``, defined in ``nghttp2_error_code``, as parameter.  But
they are not detailed enough to debug.  Therefore, we decided to use
more detailed ``nghttp2_error`` values instead.

The application using this callback should update the callback
signature.  If it treats ``error_code`` as HTTP/2 error code, update
the code so that it is treated as ``nghttp2_error``.

Receive client magic by default
+++++++++++++++++++++++++++++++

Previously nghttp2 did not process client magic (24 bytes byte
string).  To make it deal with it, we had to use
``nghttp2_option_set_recv_client_preface()``.  Since v1.0.0, nghttp2
processes client magic by default and
``nghttp2_option_set_recv_client_preface()`` was removed.

Some application may want to disable this behaviour, so we added
``nghttp2_option_set_no_recv_client_magic()`` to achieve this.

The application using ``nghttp2_option_set_recv_client_preface()``
with nonzero value, just remove it.

The application using ``nghttp2_option_set_recv_client_preface()``
with zero value or not using it must use
``nghttp2_option_set_no_recv_client_magic()`` with nonzero value.

Client, Server and Proxy programs
---------------------------------

The ``src`` directory contains the HTTP/2 client, server and proxy programs.

nghttp - client
+++++++++++++++

``nghttp`` is a HTTP/2 client.  It can connect to the HTTP/2 server
with prior knowledge, HTTP Upgrade and ALPN TLS extension.

It has verbose output mode for framing information.  Here is sample
output from ``nghttp`` client:

.. code-block:: text

    $ nghttp -nv https://nghttp2.org
    [  0.190] Connected
    The negotiated protocol: h2
    [  0.212] recv SETTINGS frame <length=12, flags=0x00, stream_id=0>
	      (niv=2)
	      [SETTINGS_MAX_CONCURRENT_STREAMS(0x03):100]
	      [SETTINGS_INITIAL_WINDOW_SIZE(0x04):65535]
    [  0.212] send SETTINGS frame <length=12, flags=0x00, stream_id=0>
	      (niv=2)
	      [SETTINGS_MAX_CONCURRENT_STREAMS(0x03):100]
	      [SETTINGS_INITIAL_WINDOW_SIZE(0x04):65535]
    [  0.212] send SETTINGS frame <length=0, flags=0x01, stream_id=0>
	      ; ACK
	      (niv=0)
    [  0.212] send PRIORITY frame <length=5, flags=0x00, stream_id=3>
	      (dep_stream_id=0, weight=201, exclusive=0)
    [  0.212] send PRIORITY frame <length=5, flags=0x00, stream_id=5>
	      (dep_stream_id=0, weight=101, exclusive=0)
    [  0.212] send PRIORITY frame <length=5, flags=0x00, stream_id=7>
	      (dep_stream_id=0, weight=1, exclusive=0)
    [  0.212] send PRIORITY frame <length=5, flags=0x00, stream_id=9>
	      (dep_stream_id=7, weight=1, exclusive=0)
    [  0.212] send PRIORITY frame <length=5, flags=0x00, stream_id=11>
	      (dep_stream_id=3, weight=1, exclusive=0)
    [  0.212] send HEADERS frame <length=39, flags=0x25, stream_id=13>
	      ; END_STREAM | END_HEADERS | PRIORITY
	      (padlen=0, dep_stream_id=11, weight=16, exclusive=0)
	      ; Open new stream
	      :method: GET
	      :path: /
	      :scheme: https
	      :authority: nghttp2.org
	      accept: */*
	      accept-encoding: gzip, deflate
	      user-agent: nghttp2/1.0.1-DEV
    [  0.221] recv SETTINGS frame <length=0, flags=0x01, stream_id=0>
	      ; ACK
	      (niv=0)
    [  0.221] recv (stream_id=13) :method: GET
    [  0.221] recv (stream_id=13) :scheme: https
    [  0.221] recv (stream_id=13) :path: /stylesheets/screen.css
    [  0.221] recv (stream_id=13) :authority: nghttp2.org
    [  0.221] recv (stream_id=13) accept-encoding: gzip, deflate
    [  0.222] recv (stream_id=13) user-agent: nghttp2/1.0.1-DEV
    [  0.222] recv PUSH_PROMISE frame <length=50, flags=0x04, stream_id=13>
	      ; END_HEADERS
	      (padlen=0, promised_stream_id=2)
    [  0.222] recv (stream_id=13) :status: 200
    [  0.222] recv (stream_id=13) date: Thu, 21 May 2015 16:38:14 GMT
    [  0.222] recv (stream_id=13) content-type: text/html
    [  0.222] recv (stream_id=13) last-modified: Fri, 15 May 2015 15:38:06 GMT
    [  0.222] recv (stream_id=13) etag: W/"555612de-19f6"
    [  0.222] recv (stream_id=13) link: </stylesheets/screen.css>; rel=preload; as=stylesheet
    [  0.222] recv (stream_id=13) content-encoding: gzip
    [  0.222] recv (stream_id=13) server: nghttpx nghttp2/1.0.1-DEV
    [  0.222] recv (stream_id=13) via: 1.1 nghttpx
    [  0.222] recv (stream_id=13) strict-transport-security: max-age=31536000
    [  0.222] recv HEADERS frame <length=166, flags=0x04, stream_id=13>
	      ; END_HEADERS
	      (padlen=0)
	      ; First response header
    [  0.222] recv DATA frame <length=2601, flags=0x01, stream_id=13>
	      ; END_STREAM
    [  0.222] recv (stream_id=2) :status: 200
    [  0.222] recv (stream_id=2) date: Thu, 21 May 2015 16:38:14 GMT
    [  0.222] recv (stream_id=2) content-type: text/css
    [  0.222] recv (stream_id=2) last-modified: Fri, 15 May 2015 15:38:06 GMT
    [  0.222] recv (stream_id=2) etag: W/"555612de-9845"
    [  0.222] recv (stream_id=2) content-encoding: gzip
    [  0.222] recv (stream_id=2) server: nghttpx nghttp2/1.0.1-DEV
    [  0.222] recv (stream_id=2) via: 1.1 nghttpx
    [  0.222] recv (stream_id=2) strict-transport-security: max-age=31536000
    [  0.222] recv HEADERS frame <length=32, flags=0x04, stream_id=2>
	      ; END_HEADERS
	      (padlen=0)
	      ; First push response header
    [  0.228] recv DATA frame <length=8715, flags=0x01, stream_id=2>
	      ; END_STREAM
    [  0.228] send GOAWAY frame <length=8, flags=0x00, stream_id=0>
	      (last_stream_id=2, error_code=NO_ERROR(0x00), opaque_data(0)=[])

The HTTP Upgrade is performed like so:

.. code-block:: text

    $ nghttp -nvu http://nghttp2.org
    [  0.011] Connected
    [  0.011] HTTP Upgrade request
    GET / HTTP/1.1
    Host: nghttp2.org
    Connection: Upgrade, HTTP2-Settings
    Upgrade: h2c
    HTTP2-Settings: AAMAAABkAAQAAP__
    Accept: */*
    User-Agent: nghttp2/1.0.1-DEV


    [  0.018] HTTP Upgrade response
    HTTP/1.1 101 Switching Protocols
    Connection: Upgrade
    Upgrade: h2c


    [  0.018] HTTP Upgrade success
    [  0.018] recv SETTINGS frame <length=12, flags=0x00, stream_id=0>
	      (niv=2)
	      [SETTINGS_MAX_CONCURRENT_STREAMS(0x03):100]
	      [SETTINGS_INITIAL_WINDOW_SIZE(0x04):65535]
    [  0.018] send SETTINGS frame <length=12, flags=0x00, stream_id=0>
	      (niv=2)
	      [SETTINGS_MAX_CONCURRENT_STREAMS(0x03):100]
	      [SETTINGS_INITIAL_WINDOW_SIZE(0x04):65535]
    [  0.018] send SETTINGS frame <length=0, flags=0x01, stream_id=0>
	      ; ACK
	      (niv=0)
    [  0.018] send PRIORITY frame <length=5, flags=0x00, stream_id=3>
	      (dep_stream_id=0, weight=201, exclusive=0)
    [  0.018] send PRIORITY frame <length=5, flags=0x00, stream_id=5>
	      (dep_stream_id=0, weight=101, exclusive=0)
    [  0.018] send PRIORITY frame <length=5, flags=0x00, stream_id=7>
	      (dep_stream_id=0, weight=1, exclusive=0)
    [  0.018] send PRIORITY frame <length=5, flags=0x00, stream_id=9>
	      (dep_stream_id=7, weight=1, exclusive=0)
    [  0.018] send PRIORITY frame <length=5, flags=0x00, stream_id=11>
	      (dep_stream_id=3, weight=1, exclusive=0)
    [  0.018] send PRIORITY frame <length=5, flags=0x00, stream_id=1>
	      (dep_stream_id=11, weight=16, exclusive=0)
    [  0.019] recv (stream_id=1) :method: GET
    [  0.019] recv (stream_id=1) :scheme: http
    [  0.019] recv (stream_id=1) :path: /stylesheets/screen.css
    [  0.019] recv (stream_id=1) host: nghttp2.org
    [  0.019] recv (stream_id=1) user-agent: nghttp2/1.0.1-DEV
    [  0.019] recv PUSH_PROMISE frame <length=49, flags=0x04, stream_id=1>
	      ; END_HEADERS
	      (padlen=0, promised_stream_id=2)
    [  0.019] recv (stream_id=1) :status: 200
    [  0.019] recv (stream_id=1) date: Thu, 21 May 2015 16:39:16 GMT
    [  0.019] recv (stream_id=1) content-type: text/html
    [  0.019] recv (stream_id=1) content-length: 6646
    [  0.019] recv (stream_id=1) last-modified: Fri, 15 May 2015 15:38:06 GMT
    [  0.019] recv (stream_id=1) etag: "555612de-19f6"
    [  0.019] recv (stream_id=1) link: </stylesheets/screen.css>; rel=preload; as=stylesheet
    [  0.019] recv (stream_id=1) accept-ranges: bytes
    [  0.019] recv (stream_id=1) server: nghttpx nghttp2/1.0.1-DEV
    [  0.019] recv (stream_id=1) via: 1.1 nghttpx
    [  0.019] recv HEADERS frame <length=157, flags=0x04, stream_id=1>
	      ; END_HEADERS
	      (padlen=0)
	      ; First response header
    [  0.019] recv DATA frame <length=6646, flags=0x01, stream_id=1>
	      ; END_STREAM
    [  0.019] recv (stream_id=2) :status: 200
    [  0.019] recv (stream_id=2) date: Thu, 21 May 2015 16:39:16 GMT
    [  0.019] recv (stream_id=2) content-type: text/css
    [  0.019] recv (stream_id=2) content-length: 38981
    [  0.019] recv (stream_id=2) last-modified: Fri, 15 May 2015 15:38:06 GMT
    [  0.019] recv (stream_id=2) etag: "555612de-9845"
    [  0.019] recv (stream_id=2) accept-ranges: bytes
    [  0.019] recv (stream_id=2) server: nghttpx nghttp2/1.0.1-DEV
    [  0.019] recv (stream_id=2) via: 1.1 nghttpx
    [  0.019] recv HEADERS frame <length=36, flags=0x04, stream_id=2>
	      ; END_HEADERS
	      (padlen=0)
	      ; First push response header
    [  0.026] recv DATA frame <length=16384, flags=0x00, stream_id=2>
    [  0.027] recv DATA frame <length=7952, flags=0x00, stream_id=2>
    [  0.027] send WINDOW_UPDATE frame <length=4, flags=0x00, stream_id=0>
	      (window_size_increment=33343)
    [  0.032] send WINDOW_UPDATE frame <length=4, flags=0x00, stream_id=2>
	      (window_size_increment=33707)
    [  0.032] recv DATA frame <length=14645, flags=0x01, stream_id=2>
	      ; END_STREAM
    [  0.032] recv SETTINGS frame <length=0, flags=0x01, stream_id=0>
	      ; ACK
	      (niv=0)
    [  0.032] send GOAWAY frame <length=8, flags=0x00, stream_id=0>
	      (last_stream_id=2, error_code=NO_ERROR(0x00), opaque_data(0)=[])

Using the ``-s`` option, ``nghttp`` prints out some timing information for
requests, sorted by completion time:

.. code-block:: text

    $ nghttp -nas https://nghttp2.org/
    ***** Statistics *****

    Request timing:
      responseEnd: the  time  when  last  byte of  response  was  received
                   relative to connectEnd
     requestStart: the time  just before  first byte  of request  was sent
                   relative  to connectEnd.   If  '*' is  shown, this  was
                   pushed by server.
          process: responseEnd - requestStart
             code: HTTP status code
             size: number  of  bytes  received as  response  body  without
                   inflation.
              URI: request URI

    see http://www.w3.org/TR/resource-timing/#processing-model

    sorted by 'complete'

    id  responseEnd requestStart  process code size request path
     13    +37.19ms       +280us  36.91ms  200   2K /
      2    +72.65ms *   +36.38ms  36.26ms  200   8K /stylesheets/screen.css
     17    +77.43ms     +38.67ms  38.75ms  200   3K /javascripts/octopress.js
     15    +78.12ms     +38.66ms  39.46ms  200   3K /javascripts/modernizr-2.0.js

Using the ``-r`` option, ``nghttp`` writes more detailed timing data to
the given file in HAR format.

nghttpd - server
++++++++++++++++

``nghttpd`` is a multi-threaded static web server.

By default, it uses SSL/TLS connection.  Use ``--no-tls`` option to
disable it.

``nghttpd`` only accepts HTTP/2 connections via ALPN or direct HTTP/2
connections.  No HTTP Upgrade is supported.

The ``-p`` option allows users to configure server push.

Just like ``nghttp``, it has a verbose output mode for framing
information.  Here is sample output from ``nghttpd``:

.. code-block:: text

    $ nghttpd --no-tls -v 8080
    IPv4: listen 0.0.0.0:8080
    IPv6: listen :::8080
    [id=1] [  1.521] send SETTINGS frame <length=6, flags=0x00, stream_id=0>
              (niv=1)
              [SETTINGS_MAX_CONCURRENT_STREAMS(0x03):100]
    [id=1] [  1.521] recv SETTINGS frame <length=12, flags=0x00, stream_id=0>
              (niv=2)
              [SETTINGS_MAX_CONCURRENT_STREAMS(0x03):100]
              [SETTINGS_INITIAL_WINDOW_SIZE(0x04):65535]
    [id=1] [  1.521] recv SETTINGS frame <length=0, flags=0x01, stream_id=0>
              ; ACK
              (niv=0)
    [id=1] [  1.521] recv PRIORITY frame <length=5, flags=0x00, stream_id=3>
              (dep_stream_id=0, weight=201, exclusive=0)
    [id=1] [  1.521] recv PRIORITY frame <length=5, flags=0x00, stream_id=5>
              (dep_stream_id=0, weight=101, exclusive=0)
    [id=1] [  1.521] recv PRIORITY frame <length=5, flags=0x00, stream_id=7>
              (dep_stream_id=0, weight=1, exclusive=0)
    [id=1] [  1.521] recv PRIORITY frame <length=5, flags=0x00, stream_id=9>
              (dep_stream_id=7, weight=1, exclusive=0)
    [id=1] [  1.521] recv PRIORITY frame <length=5, flags=0x00, stream_id=11>
              (dep_stream_id=3, weight=1, exclusive=0)
    [id=1] [  1.521] recv (stream_id=13) :method: GET
    [id=1] [  1.521] recv (stream_id=13) :path: /
    [id=1] [  1.521] recv (stream_id=13) :scheme: http
    [id=1] [  1.521] recv (stream_id=13) :authority: localhost:8080
    [id=1] [  1.521] recv (stream_id=13) accept: */*
    [id=1] [  1.521] recv (stream_id=13) accept-encoding: gzip, deflate
    [id=1] [  1.521] recv (stream_id=13) user-agent: nghttp2/1.0.0-DEV
    [id=1] [  1.521] recv HEADERS frame <length=41, flags=0x25, stream_id=13>
              ; END_STREAM | END_HEADERS | PRIORITY
              (padlen=0, dep_stream_id=11, weight=16, exclusive=0)
              ; Open new stream
    [id=1] [  1.521] send SETTINGS frame <length=0, flags=0x01, stream_id=0>
              ; ACK
              (niv=0)
    [id=1] [  1.521] send HEADERS frame <length=86, flags=0x04, stream_id=13>
              ; END_HEADERS
              (padlen=0)
              ; First response header
              :status: 200
              server: nghttpd nghttp2/1.0.0-DEV
              content-length: 10
              cache-control: max-age=3600
              date: Fri, 15 May 2015 14:49:04 GMT
              last-modified: Tue, 30 Sep 2014 12:40:52 GMT
    [id=1] [  1.522] send DATA frame <length=10, flags=0x01, stream_id=13>
              ; END_STREAM
    [id=1] [  1.522] stream_id=13 closed
    [id=1] [  1.522] recv GOAWAY frame <length=8, flags=0x00, stream_id=0>
              (last_stream_id=0, error_code=NO_ERROR(0x00), opaque_data(0)=[])
    [id=1] [  1.522] closed

nghttpx - proxy
+++++++++++++++

``nghttpx`` is a multi-threaded reverse proxy for HTTP/3, HTTP/2, and
HTTP/1.1, and powers http://nghttp2.org and supports HTTP/2 server
push.

We reworked ``nghttpx`` command-line interface, and as a result, there
are several incompatibles from 1.8.0 or earlier.  This is necessary to
extend its capability, and secure the further feature enhancements in
the future release.  Please read `Migration from nghttpx v1.8.0 or
earlier
<https://nghttp2.org/documentation/nghttpx-howto.html#migration-from-nghttpx-v1-8-0-or-earlier>`_
to know how to migrate from earlier releases.

``nghttpx`` implements `important performance-oriented features
<https://istlsfastyet.com/#server-performance>`_ in TLS, such as
session IDs, session tickets (with automatic key rotation), dynamic
record sizing, ALPN, forward secrecy and HTTP/2.  ``nghttpx`` also
offers the functionality to share ticket keys among multiple
``nghttpx`` instances via memcached.

``nghttpx`` has 2 operation modes:

================== ======================== ================ =============
Mode option        Frontend                 Backend          Note
================== ======================== ================ =============
default mode       HTTP/3, HTTP/2, HTTP/1.1 HTTP/1.1, HTTP/2 Reverse proxy
``--http2-proxy``  HTTP/3, HTTP/2, HTTP/1.1 HTTP/1.1, HTTP/2 Forward proxy
================== ======================== ================ =============

The interesting mode at the moment is the default mode.  It works like
a reverse proxy and listens for HTTP/3, HTTP/2, and HTTP/1.1 and can
be deployed as a SSL/TLS terminator for existing web server.

In all modes, the frontend connections are encrypted by SSL/TLS by
default.  To disable encryption, use the ``no-tls`` keyword in
``--frontend`` option.  If encryption is disabled, incoming HTTP/1.1
connections can be upgraded to HTTP/2 through HTTP Upgrade.  On the
other hard, backend connections are not encrypted by default.  To
encrypt backend connections, use ``tls`` keyword in ``--backend``
option.

``nghttpx`` supports a configuration file.  See the ``--conf`` option and
sample configuration file ``nghttpx.conf.sample``.

In the default mode, ``nghttpx`` works as reverse proxy to the backend
server:

.. code-block:: text

    Client <-- (HTTP/3, HTTP/2, HTTP/1.1) --> nghttpx <-- (HTTP/1.1, HTTP/2) --> Web Server
                                            [reverse proxy]

With the ``--http2-proxy`` option, it works as forward proxy, and it
is so called secure HTTP/2 proxy:

.. code-block:: text

    Client <-- (HTTP/3, HTTP/2, HTTP/1.1) --> nghttpx <-- (HTTP/1.1) --> Proxy
                                             [secure proxy]          (e.g., Squid, ATS)

The ``Client`` in the above example needs to be configured to use
``nghttpx`` as secure proxy.

At the time of this writing, both Chrome and Firefox support secure
HTTP/2 proxy.  One way to configure Chrome to use a secure proxy is to
create a proxy.pac script like this:

.. code-block:: javascript

    function FindProxyForURL(url, host) {
        return "HTTPS SERVERADDR:PORT";
    }

``SERVERADDR`` and ``PORT`` is the hostname/address and port of the
machine nghttpx is running on.  Please note that Chrome requires a valid
certificate for secure proxy.

Then run Chrome with the following arguments:

.. code-block:: text

    $ google-chrome --proxy-pac-url=file:///path/to/proxy.pac --use-npn

The backend HTTP/2 connections can be tunneled through an HTTP proxy.
The proxy is specified using ``--backend-http-proxy-uri``.  The
following figure illustrates how nghttpx talks to the outside HTTP/2
proxy through an HTTP proxy:

.. code-block:: text

    Client <-- (HTTP/3, HTTP/2, HTTP/1.1) --> nghttpx <-- (HTTP/2) --

            --===================---> HTTP/2 Proxy
              (HTTP proxy tunnel)     (e.g., nghttpx -s)

Benchmarking tool
-----------------

The ``h2load`` program is a benchmarking tool for HTTP/3, HTTP/2, and
HTTP/1.1.  The UI of ``h2load`` is heavily inspired by ``weighttp``
(https://github.com/lighttpd/weighttp).  The typical usage is as
follows:

.. code-block:: text

    $ h2load -n100000 -c100 -m100 https://localhost:8443/
    starting benchmark...
    spawning thread #0: 100 concurrent clients, 100000 total requests
    Protocol: TLSv1.2
    Cipher: ECDHE-RSA-AES128-GCM-SHA256
    Server Temp Key: ECDH P-256 256 bits
    progress: 10% done
    progress: 20% done
    progress: 30% done
    progress: 40% done
    progress: 50% done
    progress: 60% done
    progress: 70% done
    progress: 80% done
    progress: 90% done
    progress: 100% done

    finished in 771.26ms, 129658 req/s, 4.71MB/s
    requests: 100000 total, 100000 started, 100000 done, 100000 succeeded, 0 failed, 0 errored
    status codes: 100000 2xx, 0 3xx, 0 4xx, 0 5xx
    traffic: 3812300 bytes total, 1009900 bytes headers, 1000000 bytes data
                         min         max         mean         sd        +/- sd
    time for request:    25.12ms    124.55ms     51.07ms     15.36ms    84.87%
    time for connect:   208.94ms    254.67ms    241.38ms      7.95ms    63.00%
    time to 1st byte:   209.11ms    254.80ms    241.51ms      7.94ms    63.00%

The above example issued total 100,000 requests, using 100 concurrent
clients (in other words, 100 HTTP/2 sessions), and a maximum of 100 streams
per client.  With the ``-t`` option, ``h2load`` will use multiple native
threads to avoid saturating a single core on client side.

.. warning::

   **Don't use this tool against publicly available servers.** That is
   considered a DOS attack.  Please only use it against your private
   servers.

If the experimental HTTP/3 is enabled, h2load can send requests to
HTTP/3 server.  To do this, specify ``h3`` to ``--alpn-list`` option
like so:

.. code-block:: text

    $ h2load --alpn-list h3 https://127.0.0.1:4433

For nghttp2 v1.58 or earlier, use ``--npn-list`` instead of
``--alpn-list``.

HPACK tools
-----------

The ``src`` directory contains the HPACK tools.  The ``deflatehd`` program is a
command-line header compression tool.  The ``inflatehd`` program is a
command-line header decompression tool.  Both tools read input from
stdin and write output to stdout.  Errors are written to stderr.
They take JSON as input and output.  We  (mostly) use the same JSON data
format described at https://github.com/http2jp/hpack-test-case.

deflatehd - header compressor
+++++++++++++++++++++++++++++

The ``deflatehd`` program reads JSON data or HTTP/1-style header fields from
stdin and outputs compressed header block in JSON.

For the JSON input, the root JSON object must include a ``cases`` key.
Its value has to include the sequence of input header set.  They share
the same compression context and are processed in the order they
appear.  Each item in the sequence is a JSON object and it must
include a ``headers`` key.  Its value is an array of JSON objects,
which includes exactly one name/value pair.

Example:

.. code-block:: json

    {
      "cases":
      [
        {
          "headers": [
            { ":method": "GET" },
            { ":path": "/" }
          ]
        },
        {
          "headers": [
            { ":method": "POST" },
            { ":path": "/" }
          ]
        }
      ]
    }


With the ``-t`` option, the program can accept more familiar HTTP/1 style
header field blocks.  Each header set is delimited by an empty line:

Example:

.. code-block:: text

    :method: GET
    :scheme: https
    :path: /

    :method: POST
    user-agent: nghttp2

The output is in JSON object.  It should include a ``cases`` key and its
value is an array of JSON objects, which has at least the following keys:

seq
    The index of header set in the input.

input_length
    The sum of the length of the name/value pairs in the input.

output_length
    The length of the compressed header block.

percentage_of_original_size
    ``output_length`` / ``input_length`` * 100

wire
    The compressed header block as a hex string.

headers
    The input header set.

header_table_size
    The header table size adjusted before deflating the header set.

Examples:

.. code-block:: json

    {
      "cases":
      [
        {
          "seq": 0,
          "input_length": 66,
          "output_length": 20,
          "percentage_of_original_size": 30.303030303030305,
          "wire": "01881f3468e5891afcbf83868a3d856659c62e3f",
          "headers": [
            {
              ":authority": "example.org"
            },
            {
              ":method": "GET"
            },
            {
              ":path": "/"
            },
            {
              ":scheme": "https"
            },
            {
              "user-agent": "nghttp2"
            }
          ],
          "header_table_size": 4096
        }
        ,
        {
          "seq": 1,
          "input_length": 74,
          "output_length": 10,
          "percentage_of_original_size": 13.513513513513514,
          "wire": "88448504252dd5918485",
          "headers": [
            {
              ":authority": "example.org"
            },
            {
              ":method": "POST"
            },
            {
              ":path": "/account"
            },
            {
              ":scheme": "https"
            },
            {
              "user-agent": "nghttp2"
            }
          ],
          "header_table_size": 4096
        }
      ]
    }


The output can be used as the input for ``inflatehd`` and
``deflatehd``.

With the ``-d`` option, the extra ``header_table`` key is added and its
associated value includes the state of dynamic header table after the
corresponding header set was processed.  The value includes at least
the following keys:

entries
    The entry in the header table.  If ``referenced`` is ``true``, it
    is in the reference set.  The ``size`` includes the overhead (32
    bytes).  The ``index`` corresponds to the index of header table.
    The ``name`` is the header field name and the ``value`` is the
    header field value.

size
    The sum of the spaces entries occupied, this includes the
    entry overhead.

max_size
    The maximum header table size.

deflate_size
    The sum of the spaces entries occupied within
    ``max_deflate_size``.

max_deflate_size
    The maximum header table size the encoder uses.  This can be smaller
    than ``max_size``.  In this case, the encoder only uses up to first
    ``max_deflate_size`` buffer.  Since the header table size is still
    ``max_size``, the encoder has to keep track of entries outside the
    ``max_deflate_size`` but inside the ``max_size`` and make sure
    that they are no longer referenced.

Example:

.. code-block:: json

    {
      "cases":
      [
        {
          "seq": 0,
          "input_length": 66,
          "output_length": 20,
          "percentage_of_original_size": 30.303030303030305,
          "wire": "01881f3468e5891afcbf83868a3d856659c62e3f",
          "headers": [
            {
              ":authority": "example.org"
            },
            {
              ":method": "GET"
            },
            {
              ":path": "/"
            },
            {
              ":scheme": "https"
            },
            {
              "user-agent": "nghttp2"
            }
          ],
          "header_table_size": 4096,
          "header_table": {
            "entries": [
              {
                "index": 1,
                "name": "user-agent",
                "value": "nghttp2",
                "referenced": true,
                "size": 49
              },
              {
                "index": 2,
                "name": ":scheme",
                "value": "https",
                "referenced": true,
                "size": 44
              },
              {
                "index": 3,
                "name": ":path",
                "value": "/",
                "referenced": true,
                "size": 38
              },
              {
                "index": 4,
                "name": ":method",
                "value": "GET",
                "referenced": true,
                "size": 42
              },
              {
                "index": 5,
                "name": ":authority",
                "value": "example.org",
                "referenced": true,
                "size": 53
              }
            ],
            "size": 226,
            "max_size": 4096,
            "deflate_size": 226,
            "max_deflate_size": 4096
          }
        }
        ,
        {
          "seq": 1,
          "input_length": 74,
          "output_length": 10,
          "percentage_of_original_size": 13.513513513513514,
          "wire": "88448504252dd5918485",
          "headers": [
            {
              ":authority": "example.org"
            },
            {
              ":method": "POST"
            },
            {
              ":path": "/account"
            },
            {
              ":scheme": "https"
            },
            {
              "user-agent": "nghttp2"
            }
          ],
          "header_table_size": 4096,
          "header_table": {
            "entries": [
              {
                "index": 1,
                "name": ":method",
                "value": "POST",
                "referenced": true,
                "size": 43
              },
              {
                "index": 2,
                "name": "user-agent",
                "value": "nghttp2",
                "referenced": true,
                "size": 49
              },
              {
                "index": 3,
                "name": ":scheme",
                "value": "https",
                "referenced": true,
                "size": 44
              },
              {
                "index": 4,
                "name": ":path",
                "value": "/",
                "referenced": false,
                "size": 38
              },
              {
                "index": 5,
                "name": ":method",
                "value": "GET",
                "referenced": false,
                "size": 42
              },
              {
                "index": 6,
                "name": ":authority",
                "value": "example.org",
                "referenced": true,
                "size": 53
              }
            ],
            "size": 269,
            "max_size": 4096,
            "deflate_size": 269,
            "max_deflate_size": 4096
          }
        }
      ]
    }

inflatehd - header decompressor
+++++++++++++++++++++++++++++++

The ``inflatehd`` program reads JSON data from stdin and outputs decompressed
name/value pairs in JSON.

The root JSON object must include the ``cases`` key.  Its value has to
include the sequence of compressed header blocks.  They share the same
compression context and are processed in the order they appear.  Each
item in the sequence is a JSON object and it must have at least a
``wire`` key.  Its value is a compressed header block as a hex string.

Example:

.. code-block:: json

    {
      "cases":
      [
        { "wire": "8285" },
        { "wire": "8583" }
      ]
    }

The output is a JSON object.  It should include a ``cases`` key and its
value is an array of JSON objects, which has at least following keys:

seq
    The index of the header set in the input.

headers
    A JSON array that includes decompressed name/value pairs.

wire
    The compressed header block as a hex string.

header_table_size
    The header table size adjusted before inflating compressed header
    block.

Example:

.. code-block:: json

    {
      "cases":
      [
        {
          "seq": 0,
          "wire": "01881f3468e5891afcbf83868a3d856659c62e3f",
          "headers": [
            {
              ":authority": "example.org"
            },
            {
              ":method": "GET"
            },
            {
              ":path": "/"
            },
            {
              ":scheme": "https"
            },
            {
              "user-agent": "nghttp2"
            }
          ],
          "header_table_size": 4096
        }
        ,
        {
          "seq": 1,
          "wire": "88448504252dd5918485",
          "headers": [
            {
              ":method": "POST"
            },
            {
              ":path": "/account"
            },
            {
              "user-agent": "nghttp2"
            },
            {
              ":scheme": "https"
            },
            {
              ":authority": "example.org"
            }
          ],
          "header_table_size": 4096
        }
      ]
    }

The output can be used as the input for ``deflatehd`` and
``inflatehd``.

With the ``-d`` option, the extra ``header_table`` key is added and its
associated value includes the state of the dynamic header table after the
corresponding header set was processed.  The format is the same as
``deflatehd``.

Contribution
------------

[This text was composed based on 1.2. License section of curl/libcurl
project.]

When contributing with code, you agree to put your changes and new
code under the same license nghttp2 is already using unless stated and
agreed otherwise.

When changing existing source code, do not alter the copyright of
the original file(s).  The copyright will still be owned by the
original creator(s) or those who have been assigned copyright by the
original author(s).

By submitting a patch to the nghttp2 project, you (or your employer, as
the case may be) agree to assign the copyright of your submission to us.
.. the above really needs to be reworded to pass legal muster.
We will credit you for your
changes as far as possible, to give credit but also to keep a trace
back to who made what changes.  Please always provide us with your
full real name when contributing!

See `Contribution Guidelines
<https://nghttp2.org/documentation/contribute.html>`_ for more
details.

Versioning
----------

In general, we follow `Semantic Versioning <http://semver.org/>`_.

We may release PATCH releases between the regular releases, mainly for
severe security bug fixes.

We have no plan to break API compatibility changes involving soname
bump, so MAJOR version will stay 1 for the foreseeable future.

License
-------

The MIT License
