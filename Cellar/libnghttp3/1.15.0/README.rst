nghttp3
=======

nghttp3 is an implementation of `RFC 9114
<https://datatracker.ietf.org/doc/html/rfc9114>`_ HTTP/3 mapping over
QUIC and `RFC 9204 <https://datatracker.ietf.org/doc/html/rfc9204>`_
QPACK in C.

It does not depend on any particular QUIC transport implementation.

Documentation
-------------

`Online documentation <https://nghttp2.org/nghttp3/>`_ is available.

Build from git
---------------

.. code-block:: shell

   $ git clone https://github.com/ngtcp2/nghttp3
   $ cd nghttp3
   $ git submodule update --init
   $ autoreconf -i
   $ ./configure
   $ make -j$(nproc) check

HTTP/3
------

This library implements `RFC 9114
<https://datatracker.ietf.org/doc/html/rfc9114>`_ HTTP/3.  It does not
support server push.

The following extensions have been implemented:

- `Extensible Prioritization Scheme for HTTP
  <https://datatracker.ietf.org/doc/html/rfc9218>`_
- `Bootstrapping WebSockets with HTTP/3
  <https://datatracker.ietf.org/doc/html/rfc9220>`_
- `The ORIGIN Extension in HTTP/3
  <https://datatracker.ietf.org/doc/html/rfc9412>`_

It can also send and receive `SETTINGS_H3_DATAGRAM` from `HTTP
Datagrams and the Capsule Protocol
<https://datatracker.ietf.org/doc/html/rfc9297>`_.

QPACK
-----

This library implements `RFC 9204
<https://datatracker.ietf.org/doc/html/rfc9204>`_ QPACK.  It supports
dynamic table.

Optimizations
-------------

This library optionally uses AVX2, if available, to optimize its
performance.  To compile with AVX2, add ``-mavx2`` to CFLAGS.  Note
that by default, CFLAGS is set to ``-g -O2``.  When specifying CFLAGS,
include them as well (e.g., ``-g -O2 -mavx2``).

Examples
--------

- client: https://github.com/ngtcp2/ngtcp2/blob/main/examples/client.cc
- server: https://github.com/ngtcp2/ngtcp2/blob/main/examples/server.cc
- curl: https://github.com/curl/curl/blob/master/lib/vquic/curl_ngtcp2.c

License
-------

The MIT License

Copyright (c) 2019 nghttp3 contributors
