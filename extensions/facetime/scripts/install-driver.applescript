on run argv
	if (count of argv) is not 4 then error "Expected the packaged installer, trust verifier, transaction, and mode"
	set sourceInstaller to item 1 of argv
	set sourceVerifier to item 2 of argv
	set sourceTransaction to item 3 of argv
	set installMode to item 4 of argv
	if installMode is not "--install" and installMode is not "--uninstall" then error "Expected --install or --uninstall"
	set expectedInstallerDigest to "6c5955700f1067c5240ad15471d80b9ac25f54547aa7288922439f1eac04d1bb"
	set expectedVerifierDigest to "4f402898b1b9c8b230bef1c6c26675a26981d2bbccb8ebe25cf2bb3095470eb3"
	set expectedTransactionDigest to "ddc19e86c01e66a25672a3494a47e24b2ee6c0609dc4d78e37d492522b7609b3"
	set protectedCommand to "set -eu; umask 077; " & ¬
		"work=$(/usr/bin/mktemp -d /private/tmp/openclaw-driver-install.XXXXXX); " & ¬
		"cleanup() { if test -x /usr/bin/trash; then /usr/bin/trash \"$work\"; else /usr/bin/python3 -I -c 'import os, shutil, sys; p=sys.argv[1]; shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else (os.unlink(p) if os.path.lexists(p) else None)' \"$work\"; fi; }; " & ¬
		"trap cleanup EXIT; /bin/chmod 700 \"$work\"; " & ¬
		"/usr/bin/ditto " & quoted form of sourceInstaller & " \"$work/install-driver-root.sh\"; " & ¬
		"/usr/bin/ditto " & quoted form of sourceVerifier & " \"$work/verify-xcode-trust.sh\"; " & ¬
		"/usr/bin/ditto " & quoted form of sourceTransaction & " \"$work/commit-driver-transaction.sh\"; " & ¬
		"/usr/sbin/chown root:wheel \"$work/install-driver-root.sh\" \"$work/verify-xcode-trust.sh\" \"$work/commit-driver-transaction.sh\"; " & ¬
		"actual=$(/usr/bin/shasum -a 256 \"$work/install-driver-root.sh\" | /usr/bin/awk '{print $1}'); " & ¬
		"test \"$actual\" = " & quoted form of expectedInstallerDigest & "; " & ¬
		"verifier_actual=$(/usr/bin/shasum -a 256 \"$work/verify-xcode-trust.sh\" | /usr/bin/awk '{print $1}'); " & ¬
		"test \"$verifier_actual\" = " & quoted form of expectedVerifierDigest & "; " & ¬
		"transaction_actual=$(/usr/bin/shasum -a 256 \"$work/commit-driver-transaction.sh\" | /usr/bin/awk '{print $1}'); " & ¬
		"test \"$transaction_actual\" = " & quoted form of expectedTransactionDigest & "; " & ¬
		"/bin/chmod 500 \"$work/install-driver-root.sh\" \"$work/verify-xcode-trust.sh\" \"$work/commit-driver-transaction.sh\"; " & ¬
		"\"$work/install-driver-root.sh\" " & quoted form of installMode
	set installCommand to "/usr/bin/env -i HOME=/var/root LOGNAME=root USER=root TMPDIR=/private/tmp PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/sh -c " & quoted form of protectedCommand
	do shell script installCommand with administrator privileges
end run
