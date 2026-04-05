.\"                                      Hey, EMACS: -*- nroff -*-
.\" First parameter, NAME, should be all caps
.\" Second parameter, SECTION, should be 1-8, maybe w/ subsection
.\" other parameters are allowed: see man(7), man(1)
.TH SQLITE3 1 "Fri Aug 11 23:50:12 CET 2023"
.\" Please adjust this date whenever revising the manpage.
.\"
.\" Some roff macros, for reference:
.\" .nh        disable hyphenation
.\" .hy        enable hyphenation
.\" .ad l      left justify
.\" .ad b      justify to both left and right margins
.\" .nf        disable filling
.\" .fi        enable filling
.\" .br        insert line break
.\" .sp <n>    insert n+1 empty lines
.\" for manpage-specific macros, see man(7)
.SH NAME
.B sqlite3 
\- A command line interface for SQLite version 3

.SH SYNOPSIS
.B sqlite3
.RI [ options ]
.RI [ databasefile ]
.RI [ SQL ]

.SH SUMMARY
.PP
.B sqlite3
is a terminal-based front-end to the SQLite library that can evaluate
queries interactively and display the results in multiple formats.
.B sqlite3
can also be used within shell scripts and other applications to provide
batch processing features.

.SH DESCRIPTION
To start a
.B sqlite3
interactive session, invoke the
.B sqlite3
command and optionally provide the name of a database file.  If the
database file does not exist, it will be created.  If the database file
does exist, it will be opened.

For example, to create a new database file named "mydata.db", create
a table named "memos" and insert a couple of records into that table:
.sp
$ 
.B sqlite3 mydata.db
.br
SQLite version 3.43.0 2023-08-11 17:45:23
.br
Enter ".help" for usage hints.
.br
sqlite>
.B create table memos(text, priority INTEGER);
.br
sqlite>
.B insert into memos values('deliver project description', 10);
.br
sqlite>
.B insert into memos values('lunch with Christine', 100);
.br
sqlite>
.B select * from memos;
.br
deliver project description|10
.br
lunch with Christine|100
.br
sqlite>
.sp

If no database name is supplied, the ATTACH sql command can be used
to attach to existing or create new database files.  ATTACH can also
be used to attach to multiple databases within the same interactive
session.  This is useful for migrating data between databases,
possibly changing the schema along the way.

Optionally, a SQL statement or set of SQL statements can be supplied as
a single argument.  Multiple statements should be separated by
semi-colons.

For example:
.sp
$ 
.B sqlite3 -line mydata.db 'select * from memos where priority > 20;'
.br
    text = lunch with Christine
.br
priority = 100
.br
.sp

.SS SQLITE META-COMMANDS
.PP
The interactive interpreter offers a set of meta-commands that can be
used to control the output format, examine the currently attached
database files, or perform administrative operations upon the
attached databases (such as rebuilding indices).   Meta-commands are
always prefixed with a dot (.).

A list of available meta-commands can be viewed at any time by issuing
the '.help' command.  For example:
.sp
sqlite>
.B .help
.nf
.tr %.
...
.sp
.fi

The available commands differ by version and build options, so they
are not listed here. Please refer to your local copy for all available
options.


.SH INIT FILE
.B sqlite3
reads an initialization file to set the configuration of the
interactive environment.  Throughout initialization, any previously
specified setting can be overridden.  The sequence of initialization is
as follows:

o The default configuration is established as follows:

.sp
.nf
.cc |
mode            = LIST
separator       = "|"
main prompt     = "sqlite> "
continue prompt = "   ...> "
|cc .
.sp
.fi

o If the environment variable XDG_CONFIG_HOME is set then
.B ${XDG_CONFIG_HOME}/sqlite3/sqliterc
is checked, else
.B ~/.config/sqlite3/sqliterc
is checked. If the selected file does not exist then the fallback of
.B ~/.sqliterc
is used. It should generally only contain meta-commands.

o If the -init option is present, the specified file is processed.

o All other command line options are processed.

.SH HISTORY FILE
.B sqlite3
may be configured to use a history file to save SQL statements and
meta-commands entered interactively. These statements and commands can be
retrieved, edited and, reused at the main and continue prompts. If the
environment variable
.B SQLITE_HISTORY
is set, it will be used as the name of the history file, whether it
already exists or not. If it is not set but the XDG_STATE_HOME
environment variable is then
.B ${XDG_STATE_HOME}/sqlite_history
is used. If XDG_STATE_HOME is not set then
.B ~/.local/state/sqlite_history
is used. If the selected file does not exist then
.B ~/.sqlite_history
will be used as the history file. If any history file is found, it
will be written if the shell exits interactive mode normally,
regardless of whether it existed previously, though saving will
silently fail if the history file's directory does not exist.
.SH SEE ALSO
https://sqlite.org/cli.html
.br
https://sqlite.org/fiddle (a WebAssembly build of the CLI app)
.br
The sqlite3-doc package.
.SH AUTHOR
This manual page was originally written by Andreas Rottmann
<rotty@debian.org>, for the Debian GNU/Linux system (but may be used
by others). It was subsequently revised by Bill Bumgarner <bbum@mac.com>,
Laszlo Boszormenyi <gcs@debian.hu>, and the sqlite3 developers.
