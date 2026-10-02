#include <errno.h>
#include <mach/mach.h>
#include <netinet/in.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *services[] = {
        "com.apple.securityd", "com.apple.cfprefsd.agent", "com.apple.cfprefsd.daemon",
        "com.apple.WindowServer", "com.apple.tccd"
    };
    int failed = 0;
    for (int i = 0; i < 5; i++) {
        mach_port_t port = MACH_PORT_NULL;
        kern_return_t result = bootstrap_look_up(bootstrap_port, services[i], &port);
        printf("mach %s denied=%d code=%d\n", services[i], result != KERN_SUCCESS, result);
        if (result == KERN_SUCCESS) {
            failed = 1;
            mach_port_deallocate(mach_task_self(), port);
        }
    }

    errno = 0;
    FILE *file = fopen(argv[3], "r");
    int read_error = errno;
    printf("operator_file_read_denied=%d errno=%d\n", file == NULL, read_error);
    if (file != NULL || read_error != EPERM) failed = 1;
    if (file != NULL) fclose(file);

    for (int i = 1; i <= 2; i++) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in address = {0};
        address.sin_family = AF_INET;
        address.sin_port = htons(atoi(argv[i]));
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        errno = 0;
        int status = connect(fd, (struct sockaddr *)&address, sizeof(address));
        int connect_error = errno;
        printf("loopback port=%s connected=%d errno=%d\n", argv[i], status == 0, connect_error);
        close(fd);
        if ((i == 1 && status != 0) || (i == 2 && (status == 0 || connect_error != EPERM))) {
            failed = 1;
        }
    }
    return failed;
}
